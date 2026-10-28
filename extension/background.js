// Crator for ERPNext: service worker.
// Owns each tab's conversation, runs the agent loop (agent.js) with the user's own Anthropic key,
// executes tools in the page (content.js for the cursor/clicks/snapshot, the page's MAIN world for
// Frappe's JS API), and creates GPT-Live voice sessions with the user's OpenAI key.
import { runTurn } from "./agent.js";
import { agentPrompt, voicePrompt } from "./prompts.js";
import { addUsage, callCost, emptyUsage, formatTokens, formatUSD, getPrices, priceFor } from "./pricing.js";

const DEFAULTS = {
	anthropicKey: "",
	openaiKey: "",
	model: "claude-sonnet-5-5",
	voiceModel: "gpt-live-1",
	voice: "marin",
	allowChanges: false, // setup changes (custom fields, scripts, workflows) are opt-in
	confirmRisky: true, // ask before clicking Submit / Cancel / Delete / Amend
};
const API_ORIGINS = ["https://api.anthropic.com/*", "https://api.openai.com/*"];
const CHANGE_DOCTYPES = [
	"Custom Field", "Property Setter", "Client Script", "Server Script", "Notification",
	"Workflow", "Workflow State", "Workflow Action Master", "Print Format", "Custom DocPerm",
];
const RISKY = /^(submit|cancel|delete|amend|discard)\b/i;
const YES = /^\W*(yes|yeah|yep|yup|sure|ok(ay)?|apply|go ahead|do it|approve|allow)\b/i;

const getSettings = async () => ({ ...DEFAULTS, ...((await chrome.storage.local.get("settings")).settings || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Sites: the content script runs only on sites the user enabled ----------

async function siteOrigins() {
	const { origins = [] } = await chrome.permissions.getAll();
	return origins.filter((o) => !API_ORIGINS.includes(o));
}

async function syncContentScripts() {
	const matches = await siteOrigins();
	const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ["crator"] });
	if (!matches.length) {
		if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: ["crator"] });
		return;
	}
	const def = { id: "crator", matches, js: ["content.js"], runAt: "document_idle", persistAcrossSessions: true };
	await (existing.length ? chrome.scripting.updateContentScripts([def]) : chrome.scripting.registerContentScripts([def]));
}
chrome.runtime.onInstalled.addListener(syncContentScripts);
chrome.runtime.onStartup.addListener(syncContentScripts);
chrome.permissions.onAdded.addListener(syncContentScripts);
chrome.permissions.onRemoved.addListener(syncContentScripts);

// ---------- Sessions (one conversation per tab, persisted so a worker restart loses nothing) ----------

const sessions = new Map();

async function session(tabId) {
	if (sessions.has(tabId)) return sessions.get(tabId);
	const saved = (await chrome.storage.session.get(`s${tabId}`))[`s${tabId}`];
	const s = { ui: saved?.ui || [], api: saved?.api || [], busy: false, abort: null, waiter: null, queue: [] };
	// A card left pending by a previous worker can no longer be answered.
	for (const m of s.ui) if (m.role === "approval" && m.status === "pending") m.status = "cancelled";
	repairHistory(s.api);
	sessions.set(tabId, s);
	return s;
}
chrome.tabs.onRemoved.addListener((tabId) => {
	sessions.delete(tabId);
	chrome.storage.session.remove(`s${tabId}`);
});

const timers = {};
function sync(tabId, s, now = false) {
	const send = () => chrome.tabs.sendMessage(tabId, { cmd: "setChat", list: s.ui, busy: s.busy }).catch(() => {});
	if (now) {
		clearTimeout(timers[`u${tabId}`]);
		timers[`u${tabId}`] = null;
		send();
	} else if (!timers[`u${tabId}`]) {
		timers[`u${tabId}`] = setTimeout(() => {
			timers[`u${tabId}`] = null;
			send();
		}, 60);
	}
	clearTimeout(timers[`p${tabId}`]);
	timers[`p${tabId}`] = setTimeout(() => chrome.storage.session.set({ [`s${tabId}`]: { ui: s.ui.slice(-200), api: s.api } }), 400);
}

// If a turn died mid-tool, the API history ends in tool_use with no tool_result: close it off.
function repairHistory(api) {
	const last = api[api.length - 1];
	if (last?.role !== "assistant" || !Array.isArray(last.content)) return;
	const calls = last.content.filter((b) => b.type === "tool_use");
	if (calls.length) api.push({ role: "user", content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "Stopped." })) });
}

// ---------- Talking to the page ----------

// content.js (isolated world): cursor, clicks, typing, snapshot, sidebar.
async function toPage(tabId, msg, retry = true) {
	try {
		const r = await chrome.tabs.sendMessage(tabId, msg);
		if (r?.error) throw new Error(r.error);
		return r;
	} catch (e) {
		if (!retry || !/Receiving end|port closed|Could not establish/i.test(e.message)) throw e;
		// The click navigated or reloaded the page: wait for the new page, then look at it.
		await waitForContent(tabId);
		if (msg.cmd === "click" || msg.cmd === "type") return toPage(tabId, { cmd: "snapshot" }, false);
		return toPage(tabId, msg, false);
	}
}

async function waitForContent(tabId, timeout = 20000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		try {
			if ((await chrome.tabs.sendMessage(tabId, { cmd: "ping" }))?.ok) return;
		} catch {}
		await sleep(400);
	}
	throw new Error("The page didn't come back after navigating");
}

// The page's MAIN world, where Frappe's JS API (frappe, cur_frm, …) lives.
async function inPage(tabId, func, args = []) {
	const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args });
	return r?.result;
}

// Run the agent's code in the page. A failing Frappe call shows an error dialog on the user's screen and
// often never settles its promise, so race the code against (a) a new error dialog, which becomes the
// tool's error and is closed before the user has to deal with it, and (b) a timeout.
const runJs = (tabId, code) =>
	inPage(
		tabId,
		async (c) => {
			const dialog = () => document.querySelector(".modal.show .msgprint")?.closest(".modal");
			const before = dialog();
			const takePopup = () => {
				const d = dialog();
				if (!d || d === before) return "";
				const text = d.querySelector(".msgprint")?.innerText.trim() || "Frappe showed an error";
				window.frappe?.hide_msgprint?.(true);
				d.classList.remove("show"); // in case hide_msgprint didn't
				return text;
			};
			let timer;
			const watch = new Promise((resolve) => {
				timer = setInterval(() => {
					const t = takePopup();
					if (t) resolve({ ok: false, v: `Frappe error: ${t}` });
				}, 150);
			});
			const timeout = new Promise((resolve) => setTimeout(() => resolve({ ok: false, v: "Timed out after 30s (a Frappe call may have failed silently). Try another approach." }), 30000));
			const run = (async () => {
				try {
					const v = await new Function(`return (async () => { ${c} })()`)();
					await new Promise((r) => setTimeout(r, 200)); // a dialog can appear just after resolving
					const t = takePopup();
					return t ? { ok: false, v: `Frappe error: ${t}` } : { ok: true, v: JSON.stringify(v, null, 1) ?? "undefined" };
				} catch (e) {
					await new Promise((r) => setTimeout(r, 200));
					const t = takePopup();
					return { ok: false, v: `${String((e && e.message) || e)}${t ? `\nFrappe error: ${t}` : ""}` };
				}
			})();
			const result = await Promise.race([run, watch, timeout]);
			clearInterval(timer);
			return result;
		},
		[code]
	);

// POST to a Frappe method in the user's session (cookie + CSRF), without Frappe's error popups.
const frappeCall = (tabId, method, args) =>
	inPage(
		tabId,
		async (m, a) => {
			const r = await fetch(`/api/method/${m}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Frappe-CSRF-Token": window.frappe?.csrf_token },
				body: JSON.stringify(a),
			});
			const j = await r.json().catch(() => ({}));
			if (r.ok) return { ok: true, message: j.message };
			let msg = "";
			try {
				msg = JSON.parse(j._server_messages || "[]").map((x) => JSON.parse(x).message).join(" ");
			} catch {}
			return { ok: false, error: (msg || j.exception || `HTTP ${r.status}`).replace(/<[^>]+>/g, "") };
		},
		[method, args]
	);

async function siteInfo(tabId) {
	return inPage(tabId, () => {
		const f = window.frappe;
		if (!f?.boot) return null;
		const b = f.boot;
		return {
			site: b.sitename || location.host,
			user: f.session?.user,
			fullName: f.session?.user_fullname,
			roles: (f.user_roles || []).filter((r) => !["All", "Guest", "Desk User"].includes(r)).slice(0, 30),
			versions: Object.fromEntries(Object.entries(b.versions || {}).map(([k, v]) => [k, String(v)])),
			company: f.defaults?.get_user_default?.("company") || b.sysdefaults?.company,
			currency: b.sysdefaults?.currency,
			country: b.sysdefaults?.country,
			dateFormat: b.sysdefaults?.date_format,
		};
	}).catch(() => null);
}

function describeSite(info, origin) {
	if (!info) return `${origin}. This page doesn't look like a Frappe desk (not logged in?). Ask the user to log in.`;
	return [
		`URL ${origin} (site ${info.site}). Logged in as ${info.fullName || info.user} (${info.user}).`,
		`Roles: ${info.roles.join(", ") || "none listed"}.`,
		`Apps: ${Object.entries(info.versions).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
		`Default company: ${info.company || "?"}; currency ${info.currency || "?"}; country ${info.country || "?"}; date format ${info.dateFormat || "?"}.`,
	].join("\n");
}

// ---------- Skills (SKILL.md files the user adds in settings) ----------

async function getSkills(origin) {
	const { skills = [] } = await chrome.storage.local.get("skills");
	return skills.filter((s) => s.enabled !== false && (s.scope === "*" || s.scope === origin));
}

// ---------- Approvals (setup changes and risky clicks) ----------

async function askApproval(tabId, s, card) {
	const c = { role: "approval", id: crypto.randomUUID(), status: "pending", changes: [], ...card };
	s.ui.push(c);
	sync(tabId, s, true);
	const evt = await new Promise((resolve) => (s.waiter = resolve));
	if (evt.type === "chat") s.ui.push({ role: "user", text: evt.text });
	const approved = evt.type === "approve" || (evt.type === "chat" && YES.test(evt.text));
	c.status = approved ? "approved" : "cancelled";
	sync(tabId, s, true);
	return { approved, card: c, feedback: evt.type === "chat" && !approved ? evt.text : null };
}

// ---------- Setup changes (config records; instant, logged, undoable) ----------

const changeKey = (origin) => `changes:${origin}`;

async function applyOne(tabId, c) {
	if (c.action === "insert") {
		const r = await frappeCall(tabId, "frappe.client.insert", { doc: { doctype: c.doctype, ...c.values } });
		if (!r?.ok) throw new Error(`${c.doctype}: ${r?.error}`);
		return { action: "insert", doctype: c.doctype, name: r.message.name };
	}
	const cur = await frappeCall(tabId, "frappe.client.get", { doctype: c.doctype, name: c.name });
	if (!cur?.ok) throw new Error(`${c.doctype} ${c.name}: ${cur?.error}`);
	const old = Object.fromEntries(Object.keys(c.values).map((k) => [k, cur.message[k] ?? null]));
	const r = await frappeCall(tabId, "frappe.client.set_value", { doctype: c.doctype, name: c.name, fieldname: c.values });
	if (!r?.ok) throw new Error(`${c.doctype} ${c.name}: ${r?.error}`);
	return { action: "update", doctype: c.doctype, name: c.name, old };
}

const revertOne = (tabId, e) =>
	e.action === "insert"
		? frappeCall(tabId, "frappe.client.delete", { doctype: e.doctype, name: e.name })
		: frappeCall(tabId, "frappe.client.set_value", { doctype: e.doctype, name: e.name, fieldname: e.old });

async function reloadAndLook(tabId) {
	await chrome.tabs.reload(tabId);
	await sleep(800);
	await waitForContent(tabId);
	return (await toPage(tabId, { cmd: "snapshot", max: 80 })).text;
}

// ---------- Tools ----------

function toolDefs({ skills, allowChanges }) {
	const t = [
		{
			name: "look_at_screen",
			description:
				'See what is on the ERPNext page now: URL, page title, open dialog, messages, then one line per visible control, e.g. `e12 textbox "Supplier" [supplier] = "ACME"`. Refs (e12) are what the other tools act on. Call before acting and whenever the page may have changed.',
			input_schema: { type: "object", properties: { max: { type: "integer", description: "max controls to list (default 150)" } } },
		},
		{
			name: "look_closely",
			description: "Screenshot of the visible page, for when layout matters or the text view is ambiguous. Costs more; use sparingly.",
			input_schema: { type: "object", properties: {} },
		},
		{
			name: "show_me_click",
			description: "Click an element with the visible animated cursor. Returns the new screen. Submit/Cancel/Delete/Amend ask the user first.",
			input_schema: { type: "object", properties: { ref: { type: "string", description: "ref from the latest screen, e.g. e18" } }, required: ["ref"] },
		},
		{
			name: "show_me_type",
			description: "Type into a field with the visible cursor, slowly. For Link fields it picks the matching dropdown option. For a <select>, value is the option text. Returns the new screen.",
			input_schema: {
				type: "object",
				properties: {
					ref: { type: "string" },
					value: { type: "string" },
					pick_option: { type: "boolean", description: "pick the matching autocomplete option (default true)" },
				},
				required: ["ref", "value"],
			},
		},
		{
			name: "run_js",
			description:
				"Run JavaScript in the page with Frappe's client API (frappe, cur_frm, cur_list, frappe.query_report). For reading data (`return await frappe.db.get_list('Item', {fields: ['name'], limit: 5})`; counts: `await frappe.db.count('Sales Order', {customer: 'X'})`; never put SQL like `count(name)` in fields, newer Frappe rejects it: fetch the rows and count/group them in JavaScript), report filters (`frappe.query_report.set_filter_value('warehouse', ['Stores - X'])`), child rows, date fields (`await cur_frm.set_value('schedule_date', '2026-11-05')`), and inspecting forms (`await frappe.model.with_doctype(dt); return frappe.get_meta(dt).fields.map(f => [f.fieldname, f.label, f.fieldtype])`). Body of an async function; `return` a JSON-serialisable value.",
			input_schema: {
				type: "object",
				properties: {
					code: { type: "string" },
					why: { type: "string", description: 'a few words shown to the user, e.g. "Reading Work Order fields"' },
				},
				required: ["code", "why"],
			},
		},
		{
			name: "go_to",
			description: "Jump straight to a desk path like /app/material-request. Only when the user asks to skip ahead.",
			input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	];
	if (skills.length) {
		t.push({
			name: "read_skill",
			description: `Read one of this site's skill files in full: ${skills.map((s) => s.name).join(", ")}.`,
			input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
		});
	}
	if (allowChanges) {
		t.push(
			{
				name: "change_erp",
				description: `Change how ERPNext is set up (instant, no restart): config records only. The user sees an Apply/Cancel card with your summary and the exact changes; nothing happens until they apply. After it applies the page reloads; then DEMONSTRATE the change on screen.
Allowed doctypes: ${CHANGE_DOCTYPES.join(", ")}.
- New field: Custom Field {dt, fieldname, label, fieldtype, insert_after, options?, reqd?, in_list_view?, in_standard_filter?, description?}. Select options newline-separated; Link options = target DocType.
- Tweak a standard field: Property Setter {doctype_or_field: "DocField", doc_type, field_name, property, value, property_type}.
- Form behaviour: Client Script {name, dt, view: "Form", enabled: 1, script}.
- Rule on save: Server Script {name, script_type: "DocType Event", reference_doctype, doctype_event, script} (often disabled on hosted sites).
- Alerts: Notification. Approval flow: Workflow (+ Workflow State / Workflow Action Master rows).`,
				input_schema: {
					type: "object",
					properties: {
						summary: { type: "string", description: "Plain words for a business owner: what changes and what they'll notice." },
						changes: {
							type: "array",
							minItems: 1,
							items: {
								type: "object",
								properties: {
									action: { type: "string", enum: ["insert", "update"] },
									doctype: { type: "string", enum: CHANGE_DOCTYPES },
									name: { type: "string", description: "required for update" },
									values: { type: "object" },
								},
								required: ["action", "doctype", "values"],
							},
						},
					},
					required: ["summary", "changes"],
				},
			},
			{
				name: "undo_change",
				description: "Undo the most recent setup change(s) made with change_erp on this site. Ask the user first.",
				input_schema: { type: "object", properties: { count: { type: "integer" } } },
			}
		);
	}
	return t;
}

async function executeTool(ctx, name, input) {
	const { tabId, s, settings, origin, skills } = ctx;
	const step = (text) => {
		s.ui.push({ role: "activity", text });
		sync(tabId, s);
	};
	switch (name) {
		case "look_at_screen":
			step("Looking at the screen");
			return { text: (await toPage(tabId, { cmd: "snapshot", max: input.max || 150 })).text };
		case "look_closely": {
			step("Taking a screenshot");
			const tab = await chrome.tabs.get(tabId);
			const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
			return { image: url.split(",")[1] };
		}
		case "show_me_click": {
			const label = (await toPage(tabId, { cmd: "labelOf", ref: input.ref })).label || "";
			if (settings.confirmRisky && RISKY.test(label.trim())) {
				const { approved, feedback } = await askApproval(tabId, s, {
					title: `Let Crator click “${label}”?`,
					summary:
						/submit/i.test(label)
							? "Submitting makes this document final and posts its stock and accounting entries. After that it can only be cancelled or amended."
							: `“${label}” can't be quietly undone.`,
				});
				if (!approved) return { text: feedback ? `User didn't allow it. They said: "${feedback}"` : "User didn't allow that click. Ask what they'd like instead." };
			}
			step(label ? `Clicking “${label}”` : "Clicking");
			return { text: (await toPage(tabId, { cmd: "click", ref: input.ref })).text };
		}
		case "show_me_type": {
			const label = (await toPage(tabId, { cmd: "labelOf", ref: input.ref })).label || "";
			step(`Typing “${input.value}”${label && label !== input.value ? ` into ${label}` : ""}`);
			return { text: (await toPage(tabId, { cmd: "type", ref: input.ref, text: input.value, pick: input.pick_option !== false })).text };
		}
		case "run_js": {
			step(input.why || "Working in the page");
			const r = await runJs(tabId, input.code);
			await sleep(300);
			const screen = (await toPage(tabId, { cmd: "snapshot", max: 60 })).text;
			return { text: `${r?.ok ? "result" : "ERROR"}: ${String(r?.v).slice(0, 8000)}\n\n${screen}`, isError: !r?.ok };
		}
		case "go_to": {
			step(`Opening ${input.path}`);
			await chrome.tabs.update(tabId, { url: origin + input.path });
			await sleep(800);
			await waitForContent(tabId);
			return { text: (await toPage(tabId, { cmd: "snapshot" })).text };
		}
		case "read_skill": {
			step(`Reading ${input.name}`);
			const sk = skills.find((x) => x.name.toLowerCase() === String(input.name).toLowerCase());
			return { text: sk ? sk.content : `No skill named "${input.name}". Available: ${skills.map((x) => x.name).join(", ")}` };
		}
		case "change_erp": {
			step("Proposing a change");
			const bad = input.changes.find((c) => !CHANGE_DOCTYPES.includes(c.doctype));
			if (bad) return { text: `Not allowed: ${bad.doctype}`, isError: true };
			const { approved, card, feedback } = await askApproval(tabId, s, { kind: "change", summary: input.summary, changes: input.changes });
			if (!approved) return { text: feedback ? `Not applied. The user said: "${feedback}". Adjust or answer them.` : "User cancelled; nothing changed." };
			card.status = "applying";
			sync(tabId, s, true);
			const applied = [];
			try {
				for (const c of input.changes) applied.push(await applyOne(tabId, c));
			} catch (e) {
				for (const a of applied.reverse()) await revertOne(tabId, a); // all or nothing
				card.status = "failed";
				sync(tabId, s, true);
				return { text: `FAILED, rolled back, nothing changed: ${e.message}`, isError: true };
			}
			const key = changeKey(origin);
			const log = (await chrome.storage.local.get(key))[key] || [];
			log.push(...applied.map((a) => ({ ...a, summary: input.summary, at: new Date().toISOString() })));
			await chrome.storage.local.set({ [key]: log });
			card.status = "applied";
			card.applied = applied;
			sync(tabId, s, true);
			const screen = await reloadAndLook(tabId);
			return { text: `Applied: ${applied.map((a) => `${a.action} ${a.doctype} ${a.name}`).join("; ")}. Page reloaded. Now show it to the user.\n\n${screen}` };
		}
		case "undo_change": {
			step("Undoing a change");
			const key = changeKey(origin);
			const log = (await chrome.storage.local.get(key))[key] || [];
			const undo = log.splice(-(input.count || 1));
			const out = [];
			for (const e of undo.reverse()) {
				const r = await revertOne(tabId, e);
				out.push(`${r?.ok ? "undid" : "FAILED to undo"} ${e.action} ${e.doctype} ${e.name}${r?.ok ? "" : `: ${r?.error}`}`);
			}
			await chrome.storage.local.set({ [key]: log });
			await reloadAndLook(tabId);
			return { text: out.join("\n") || "Nothing to undo." };
		}
	}
	return { text: `Unknown tool ${name}`, isError: true };
}

// ---------- A turn ----------

// ---------- Usage and cost ----------

function costLine({ usage: u, usd, model, source, pricedAt }) {
	const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
	const inTotal = u.input + u.cacheRead + u.cacheWrite;
	const cached = inTotal ? Math.round((u.cacheRead / inTotal) * 100) : 0;
	const when = pricedAt ? ` (updated ${new Date(pricedAt).toLocaleDateString()})` : "";
	return {
		role: "cost",
		note:
			usd != null
				? `Estimated at ${model} list prices from the ${source}${when}. Your provider's billing is the source of truth.`
				: `No published price found for ${model}; tokens are still counted.`,
		text: [usd != null ? formatUSD(usd) : null, `${formatTokens(tokens)} tokens`, cached ? `${cached}% cached` : null, `${u.calls} step${u.calls > 1 ? "s" : ""}`]
			.filter(Boolean)
			.join(" · "),
		usd,
	};
}

// Running totals per month and per site, shown on the settings page.
async function recordUsage(origin, usd, u) {
	const month = new Date().toISOString().slice(0, 7);
	const { usage = {} } = await chrome.storage.local.get("usage");
	const m = (usage[month] ||= { usd: 0, tasks: 0, tokens: 0, unpriced: 0, voiceSeconds: 0, sites: {} });
	const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
	m.tasks += 1;
	m.tokens += tokens;
	if (usd == null) m.unpriced += tokens;
	else m.usd += usd;
	const site = (m.sites[origin] ||= { usd: 0, tasks: 0 });
	site.tasks += 1;
	site.usd += usd || 0;
	await chrome.storage.local.set({ usage });
}

async function recordVoice(seconds) {
	const month = new Date().toISOString().slice(0, 7);
	const { usage = {} } = await chrome.storage.local.get("usage");
	const m = (usage[month] ||= { usd: 0, tasks: 0, tokens: 0, unpriced: 0, voiceSeconds: 0, sites: {} });
	m.voiceSeconds = (m.voiceSeconds || 0) + Math.max(0, Math.round(seconds));
	await chrome.storage.local.set({ usage });
}

async function startTurn(tabId, text, voice) {
	const s = await session(tabId);
	if (s.busy) {
		s.queue.push({ text, voice });
		s.ui.push({ role: "user", text });
		sync(tabId, s, true);
		return;
	}
	s.ui.push({ role: "user", text });
	s.busy = true;
	sync(tabId, s, true);

	const settings = await getSettings();
	try {
		if (!settings.anthropicKey) throw new Error("Add your Anthropic API key in Crator's settings (the gear icon) to get started.");
		const tab = await chrome.tabs.get(tabId);
		const url = new URL(tab.url);
		const origin = url.origin;
		const [info, skills] = await Promise.all([siteInfo(tabId), getSkills(origin)]);
		const mode = voice
			? "[Voice mode: everything you write is read aloud as you work. One short spoken sentence before each action, plain words, no tables, lists, markdown or symbols, no ref ids. Finish with one or two spoken sentences.]\n"
			: "";
		s.api.push({ role: "user", content: `[User is on: ${url.pathname}]\n${mode}${text}` });
		s.abort = new AbortController();
		const ctx = { tabId, s, settings, origin, skills };
		const prices = await getPrices();
		const price = priceFor(prices, settings.model);
		// usd stays null when the model has no known price: tokens are still counted.
		s.turn = { usage: emptyUsage(), model: settings.model, origin, price, usd: price ? 0 : null, source: prices.source, pricedAt: prices.fetchedAt };
		await runTurn({
			apiKey: settings.anthropicKey,
			model: settings.model,
			system: agentPrompt({ site: describeSite(info, origin), skills, allowChanges: settings.allowChanges }),
			tools: toolDefs({ skills, allowChanges: settings.allowChanges }),
			messages: s.api,
			signal: s.abort.signal,
			onTextBlockStart: () => {
				s.ui.push({ role: "assistant", text: "" });
				sync(tabId, s);
			},
			onText: (d) => {
				const last = s.ui[s.ui.length - 1];
				if (last?.role === "assistant") last.text += d;
				else s.ui.push({ role: "assistant", text: d });
				sync(tabId, s);
			},
			onUsage: (u) => {
				addUsage(s.turn.usage, u);
				if (s.turn.price) s.turn.usd += callCost(s.turn.price, u);
			},
			executeTool: (name, input) => executeTool(ctx, name, input),
		});
	} catch (e) {
		repairHistory(s.api);
		s.ui.push(e.name === "AbortError" ? { role: "activity", text: "Stopped" } : { role: "assistant", text: `**Couldn't finish:** ${e.message}` });
	}
	if (s.turn?.usage.calls) {
		s.ui.push(costLine(s.turn));
		await recordUsage(s.turn.origin, s.turn.usd, s.turn.usage);
	}
	s.turn = null;
	s.busy = false;
	s.abort = null;
	sync(tabId, s, true);
	const next = s.queue.shift();
	if (next) {
		s.ui.pop(); // it was shown when queued; startTurn shows it again
		startTurn(tabId, next.text, next.voice);
	}
}

// ---------- Voice: create a GPT-Live session with the user's OpenAI key ----------

async function liveSession(tabId, sdp, resume) {
	const settings = await getSettings();
	if (!settings.openaiKey) return { error: "Add an OpenAI API key in Crator's settings to use voice." };
	const tab = await chrome.tabs.get(tabId);
	const origin = new URL(tab.url).origin;
	const skills = await getSkills(origin);
	const skillsBrief = skills.map((s) => s.description || s.content.slice(0, 200)).join(" ").slice(0, 600);
	let instructions = voicePrompt({ siteName: new URL(origin).host, skillsBrief });
	if (resume) instructions += `\n\nYou just reconnected after the page refreshed. The last thing that happened: ${resume}`;
	const r = await fetch("https://api.openai.com/v1/live/sessions", {
		method: "POST",
		headers: { Authorization: `Bearer ${settings.openaiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			session: {
				model: settings.voiceModel,
				instructions,
				audio: { output: { voice: settings.voice } },
				delegation: { type: "client", acknowledgement_delay_ms: 700 },
			},
			transport: { type: "webrtc", sdp },
		}),
	});
	const j = await r.json().catch(() => ({}));
	if (!r.ok) return { error: j.error?.message || `OpenAI error ${r.status}` };
	return { sdp: j.transport.sdp };
}

// ---------- Messages from the page, the popup and the options page ----------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
	const tabId = sender.tab?.id ?? msg.tabId;
	(async () => {
		switch (msg.kind) {
			case "hello": {
				const s = await session(tabId);
				const settings = await getSettings();
				return { list: s.ui, busy: s.busy, hasKey: Boolean(settings.anthropicKey), hasVoice: Boolean(settings.openaiKey) };
			}
			case "heartbeat": // keeps this worker alive while a task or a voice call is running
				return { ok: true };
			case "chat": {
				const s = await session(tabId);
				if (s.waiter) {
					const w = s.waiter;
					s.waiter = null;
					w({ type: "chat", text: msg.text });
				} else startTurn(tabId, msg.text, msg.voice);
				return { ok: true };
			}
			case "approve":
			case "reject": {
				const s = await session(tabId);
				if (s.waiter) {
					const w = s.waiter;
					s.waiter = null;
					w({ type: msg.kind });
				}
				return { ok: true };
			}
			case "stop": {
				const s = await session(tabId);
				s.queue = [];
				if (s.waiter) {
					const w = s.waiter;
					s.waiter = null;
					w({ type: "reject" });
				}
				s.abort?.abort();
				return { ok: true };
			}
			case "new-chat": {
				const s = await session(tabId);
				if (s.busy) return { ok: false };
				s.ui = [];
				s.api = [];
				sync(tabId, s, true);
				return { ok: true };
			}
			case "open-customize":
				await inPage(tabId, (dt) => {
					window.frappe.route_options = { doc_type: dt };
					window.frappe.set_route("Form", "Customize Form");
				}, [msg.doctype]);
				return { ok: true };
			case "open-doc":
				await inPage(tabId, (dt, name) => window.frappe.set_route("Form", dt, name), [msg.doctype, msg.name]);
				return { ok: true };
			case "open-settings":
				chrome.runtime.openOptionsPage();
				return { ok: true };
			case "live-session":
				return liveSession(tabId, msg.sdp, msg.resume);
			case "prices":
				return getPrices({ force: Boolean(msg.force) }).then((p) => ({ source: p.source, fetchedAt: p.fetchedAt, models: Object.keys(p.table).length }));
			case "voice-usage":
				await recordVoice(msg.seconds);
				return { ok: true };
			case "site-enabled": // from the popup, right after the user granted access to a site
				await syncContentScripts();
				await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ["content.js"] }).catch(() => {});
				return { ok: true };
		}
		return { error: `unknown message ${msg.kind}` };
	})().then(reply, (e) => reply({ error: String(e.message || e) }));
	return true;
});
