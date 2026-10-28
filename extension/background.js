// ShowMe for ERPNext: service worker.
// Owns each tab's conversation, runs the agent loop (agent.js) with the user's own Anthropic key,
// executes tools in the page (content.js for the cursor/clicks/snapshot, the page's MAIN world for
// Frappe's JS API), and creates GPT-Live voice sessions with the user's OpenAI key.
import { compact, quick, runTurn } from "./agent.js";
import { agentPrompt, voicePrompt } from "./prompts.js";
import { addUsage, callCost, emptyUsage, formatTokens, formatUSD, getPrices, priceFor } from "./pricing.js";
import { deleteAll, deleteConversation, getConversation, getTranscript, listConversations, prune, saveConversation, stats, updateMeta } from "./store.js";

const DEFAULTS = {
	keepDays: 90, // conversations not touched for this long are deleted (pinned ones are kept)
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
	// Installs from before the rename registered the script as "crator": remove that so it isn't injected twice.
	if ((await chrome.scripting.getRegisteredContentScripts({ ids: ["crator"] })).length) await chrome.scripting.unregisterContentScripts({ ids: ["crator"] });
	const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ["showme"] });
	if (!matches.length) {
		if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: ["showme"] });
		return;
	}
	const def = { id: "showme", matches, js: ["content.js"], runAt: "document_idle", persistAcrossSessions: true };
	await (existing.length ? chrome.scripting.updateContentScripts([def]) : chrome.scripting.registerContentScripts([def]));
}
chrome.runtime.onInstalled.addListener(syncContentScripts);
chrome.runtime.onStartup.addListener(syncContentScripts);
chrome.permissions.onAdded.addListener(syncContentScripts);
chrome.permissions.onRemoved.addListener(syncContentScripts);

// ---------- Conversations (stored in IndexedDB, see store.js; each tab shows one) ----------

const convs = new Map(); // id -> live state: { meta, ui, api, frozen, busy, abort, waiter, queue, turn }
const RESUME_WITHIN_MS = 6 * 60 * 60 * 1000; // a new tab picks up the site's latest conversation if recent

const newId = () => crypto.randomUUID();

function blankConv(site) {
	const now = Date.now();
	return {
		meta: { id: newId(), site, title: "New conversation", titleSource: "pending", createdAt: now, updatedAt: now, pinned: false, usd: 0, tokens: 0 },
		ui: [],
		api: [],
		frozen: null,
		busy: false, abort: null, waiter: null, queue: [], turn: null,
	};
}

async function loadConv(id) {
	if (convs.has(id)) return convs.get(id);
	const [meta, t] = await Promise.all([getConversation(id), getTranscript(id)]);
	if (!meta) return null;
	const c = { meta, ui: t?.ui || [], api: t?.api || [], frozen: t?.frozen || null, busy: false, abort: null, waiter: null, queue: [], turn: null };
	// A card left pending by a previous worker can no longer be answered.
	for (const m of c.ui) if (m.role === "approval" && m.status === "pending") m.status = "cancelled";
	repairHistory(c.api);
	convs.set(id, c);
	return c;
}

const tabKey = (tabId) => `tab:${tabId}`;

// The conversation a tab shows: its own if it has one, else the site's latest recent one, else a new one.
async function convForTab(tabId, site) {
	const key = tabKey(tabId);
	const { [key]: id } = await chrome.storage.session.get(key);
	if (id) {
		const c = await loadConv(id);
		if (c && c.meta.site === site) return c;
	}
	const [latest] = await listConversations(site, 1);
	let c = latest && Date.now() - latest.updatedAt < RESUME_WITHIN_MS ? await loadConv(latest.id) : null;
	if (!c || c.busy) {
		c = blankConv(site);
		convs.set(c.meta.id, c); // saved on first message, so empty chats don't pile up in History
	}
	await chrome.storage.session.set({ [key]: c.meta.id });
	return c;
}

async function showInTab(tabId, c) {
	await chrome.storage.session.set({ [tabKey(tabId)]: c.meta.id });
	sync(c, true, [tabId]);
}

async function tabsShowing(c) {
	const all = await chrome.storage.session.get(null);
	return Object.entries(all).filter(([k, v]) => k.startsWith("tab:") && v === c.meta.id).map(([k]) => Number(k.slice(4)));
}

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(tabKey(tabId)));

const timers = {};
// Push the transcript to every tab showing this conversation (throttled while streaming) and save it.
function sync(c, now = false, onlyTabs = null) {
	const id = c.meta.id;
	const send = async () => {
		const tabs = onlyTabs || (await tabsShowing(c));
		const payload = { cmd: "setChat", list: c.ui, busy: c.busy, conv: { id, title: c.meta.title } };
		for (const t of tabs) chrome.tabs.sendMessage(t, payload).catch(() => {});
	};
	if (now) {
		clearTimeout(timers[`u${id}`]);
		timers[`u${id}`] = null;
		send();
	} else if (!timers[`u${id}`]) {
		timers[`u${id}`] = setTimeout(() => {
			timers[`u${id}`] = null;
			send();
		}, 60);
	}
	if (!c.ui.length) return; // nothing worth saving yet
	clearTimeout(timers[`p${id}`]);
	timers[`p${id}`] = setTimeout(() => saveConversation(c.meta, { ui: c.ui, api: c.api, frozen: c.frozen }).catch(() => {}), 400);
}

// If a turn died mid-tool, the API history ends in tool_use with no tool_result: close it off.
function repairHistory(api) {
	const last = api[api.length - 1];
	if (last?.role !== "assistant" || !Array.isArray(last.content)) return;
	const calls = last.content.filter((b) => b.type === "tool_use");
	if (calls.length) api.push({ role: "user", content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "Stopped." })) });
}

// ---------- Talking to the page ----------

// content.js (isolated world): cursor, clicks, typing, snapshot, the bar.
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

// Append a learned fact to this site's "site-notes" skill (created on first use). Only called after the
// user pressed Remember on the card, so nothing about their setup is stored without their say-so.
async function appendSiteNote(origin, fact) {
	const { skills = [] } = await chrome.storage.local.get("skills");
	let sk = skills.find((x) => x.name === "site-notes" && x.scope === origin);
	if (!sk) {
		sk = {
			id: crypto.randomUUID(),
			name: "site-notes",
			description: "Facts about how this business uses ERPNext, saved from conversations with your approval",
			content: "# Site notes\nLearned in conversations, each saved after you approved it. Edit freely.\n",
			scope: origin,
			enabled: true,
		};
		skills.push(sk);
	}
	sk.content = `${sk.content.trimEnd()}\n- ${fact} _(saved ${new Date().toISOString().slice(0, 10)})_\n`;
	await chrome.storage.local.set({ skills });
}

// ---------- Approvals (setup changes and risky clicks) ----------

async function askApproval(tabId, s, card) {
	const c = { role: "approval", id: crypto.randomUUID(), status: "pending", changes: [], ...card };
	s.ui.push(c);
	sync(s, true);
	const evt = await new Promise((resolve) => (s.waiter = resolve));
	if (evt.type === "chat") s.ui.push({ role: "user", text: evt.text });
	const approved = evt.type === "approve" || (evt.type === "chat" && YES.test(evt.text));
	c.status = approved ? "approved" : "cancelled";
	sync(s, true);
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
	t.push({
		name: "remember_setup_fact",
		description:
			"Propose saving a durable fact about how THIS business uses ERPNext to the site's notes (a skill file), so future conversations know it. The user sees it on an approval card; nothing is saved unless they press Remember. Use for vocabulary (\"indent\" = Material Request), which company/warehouse/price list is used for what, naming conventions, what a custom field means, recurring preferences. The user must have stated or confirmed it. Not for one-off data (a specific order, a count), not for anything already in the skills, at most one per task.",
		input_schema: {
			type: "object",
			properties: {
				fact: { type: "string", description: "One line, in the user's terms, e.g. \"Indent means Material Request (type Purchase).\"" },
				why: { type: "string", description: "Where this came from, e.g. \"You said this while raising MAT-MR-0004\"" },
			},
			required: ["fact", "why"],
		},
	});
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
	const step = (text, extra = {}) => {
		s.ui.push({ role: "activity", text, ...extra });
		sync(s);
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
					ref: input.ref,
					title: `Let ShowMe click “${label}”?`,
					summary:
						/submit/i.test(label)
							? "Submitting makes this document final and posts its stock and accounting entries. After that it can only be cancelled or amended."
							: `“${label}” can't be quietly undone.`,
				});
				if (!approved) return { text: feedback ? `User didn't allow it. They said: "${feedback}"` : "User didn't allow that click. Ask what they'd like instead." };
			}
			step(label ? `Clicking “${label}”` : "Clicking", { ref: input.ref, target: (label || "Click").replace(/\s*⌘K$/, "") });
			return { text: (await toPage(tabId, { cmd: "click", ref: input.ref })).text };
		}
		case "show_me_type": {
			const label = (await toPage(tabId, { cmd: "labelOf", ref: input.ref })).label || "";
			// Trail label reads like the path a person follows: what was typed into a search box is the
			// destination ("New Material Request"); into a field it's "Field: value".
			const isSearch = /search|type a command|awesome/i.test(label);
			step(`Typing “${input.value}”${label && label !== input.value ? ` into ${label}` : ""}`, { ref: input.ref, target: isSearch || !label ? input.value : `${label}: ${input.value}` });
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
		case "remember_setup_fact": {
			step("Proposing a note about your setup");
			const fact = String(input.fact || "").trim().replace(/\s+/g, " ").slice(0, 300);
			if (!fact) return { text: "Empty fact; nothing proposed.", isError: true };
			const { approved, feedback } = await askApproval(tabId, s, {
				kind: "memory",
				title: "Remember this about your setup?",
				summary: `${fact}\n\n_${input.why || ""}_`,
				detail: `Saved to "site-notes" for ${new URL(origin).host}, used from your next conversation. Edit or remove it in Settings → Skills.`,
			});
			if (!approved) return { text: feedback ? `Not saved. The user said: "${feedback}"` : "Not saved; the user declined." };
			await appendSiteNote(origin, fact);
			return { text: "Saved to site-notes. It applies from the next conversation; you already know it here." };
		}
		case "change_erp": {
			step("Proposing a change");
			const bad = input.changes.find((c) => !CHANGE_DOCTYPES.includes(c.doctype));
			if (bad) return { text: `Not allowed: ${bad.doctype}`, isError: true };
			const { approved, card, feedback } = await askApproval(tabId, s, { kind: "change", summary: input.summary, changes: input.changes });
			if (!approved) return { text: feedback ? `Not applied. The user said: "${feedback}". Adjust or answer them.` : "User cancelled; nothing changed." };
			card.status = "applying";
			sync(s, true);
			const applied = [];
			try {
				for (const c of input.changes) applied.push(await applyOne(tabId, c));
			} catch (e) {
				for (const a of applied.reverse()) await revertOne(tabId, a); // all or nothing
				card.status = "failed";
				sync(s, true);
				return { text: `FAILED, rolled back, nothing changed: ${e.message}`, isError: true };
			}
			const key = changeKey(origin);
			const log = (await chrome.storage.local.get(key))[key] || [];
			log.push(...applied.map((a) => ({ ...a, summary: input.summary, at: new Date().toISOString() })));
			await chrome.storage.local.set({ [key]: log });
			card.status = "applied";
			card.applied = applied;
			sync(s, true);
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

// ---------- Usage and cost ----------

function costLine({ usage: u, usd, model, source, pricedAt, calls, edits }) {
	const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
	const inTotal = u.input + u.cacheRead + u.cacheWrite;
	const cached = inTotal ? Math.round((u.cacheRead / inTotal) * 100) : 0;
	const when = pricedAt ? ` (updated ${new Date(pricedAt).toLocaleDateString()})` : "";
	return {
		role: "cost",
		calls,
		cleared: edits || 0,
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

// Spend that isn't a task of its own (titles, compaction): added to the month and site, not the task count.
async function recordExtra(origin, usd, u) {
	const month = new Date().toISOString().slice(0, 7);
	const { usage = {} } = await chrome.storage.local.get("usage");
	const m = (usage[month] ||= { usd: 0, tasks: 0, tokens: 0, unpriced: 0, voiceSeconds: 0, sites: {} });
	const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
	m.tokens += tokens;
	if (usd == null) m.unpriced += tokens;
	else m.usd += usd;
	const site = (m.sites[origin] ||= { usd: 0, tasks: 0 });
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

// ---------- Context management (thresholds tuned from measured sessions, see scripts/long-session.mjs) ----------

// Clear old tool results server-side once the prompt passes 30k tokens, keeping the last 3; only when it
// frees at least 10k, so the cache invalidation it causes pays for itself.
const CONTEXT_EDITING = {
	edits: [
		{
			type: "clear_tool_uses_20250919",
			trigger: { type: "input_tokens", value: 30000 },
			keep: { type: "tool_uses", value: 3 },
			clear_at_least: { type: "input_tokens", value: 10000 },
			exclude_tools: ["read_skill"],
		},
	],
};
// Tests lower the threshold through settings.devClearAt (not exposed in the UI).
const withTrigger = (cm, at) => ({ edits: cm.edits.map((e) => ({ ...e, trigger: { type: "input_tokens", value: at }, clear_at_least: { type: "input_tokens", value: Math.min(2000, at / 4) } })) });

// Between tasks, summarise the conversation once it passes this many tokens (rare: days of use).
const COMPACT_AT = 60000;
const COMPACT_INSTRUCTIONS = `Summarise this conversation between a user and ShowMe, an assistant that operates their ERPNext
on screen. Start with a numbered list of every request the user made, in order, quoted in their own words, each
followed by a one-line answer or outcome (with the key numbers or document names). Then keep, word for word where it matters: every document created or edited (doctype and name/ID) and its
state (draft/submitted); setup changes applied or declined; facts about how THIS business uses ERPNext (names,
warehouses, companies, vocabulary, preferences); answers already given to data questions with their numbers;
anything still open or promised. Drop screen snapshots, element refs and step-by-step clicking. Do not call
tools; respond with the summary text only.`;

async function maybeCompact(c, settings) {
	const last = c.lastPrompt || 0;
	if (last < (settings.devCompactAt || COMPACT_AT) || !c.frozen) return;
	c.ui.push({ role: "activity", text: "Condensing earlier conversation" });
	sync(c, true);
	const r = await compact({ apiKey: settings.anthropicKey, model: c.frozen.model, system: c.frozen.system, tools: c.frozen.tools, messages: c.api, instructions: COMPACT_INSTRUCTIONS }).catch((e) => ({ ok: false, reason: e.message }));
	if (r.usage) await addCost(c, c.frozen.model, r.usage);
	if (r.ok) {
		c.api = [r.message]; // the signed block replaces everything it summarises; the UI transcript stays whole
		c.lastPrompt = 0;
		c.ui.push({ role: "note", text: "Earlier conversation condensed to keep things fast. Nothing visible here was removed." });
	} else c.ui.push({ role: "note", text: `Couldn't condense the conversation (${r.reason}); continuing as is.` });
	sync(c, true);
}

// Title from the first exchange, with a cheap model; never overwrite a title the user set.
async function maybeTitle(c, settings) {
	if (c.meta.titleSource !== "pending") return;
	const q = c.ui.find((m) => m.role === "user")?.text || "";
	const a = c.ui.find((m) => m.role === "assistant" && m.text.trim())?.text || "";
	c.meta.title = q.slice(0, 60) || "Conversation"; // placeholder until the model answers
	try {
		const { text, usage } = await quick({
			apiKey: settings.anthropicKey,
			model: TITLE_MODEL,
			prompt: `Write a 3-6 word title for this ERPNext help conversation. Sentence case, no quotes or punctuation at the end.\n\nUser: ${q.slice(0, 400)}\nAssistant: ${a.slice(0, 400)}`,
		});
		await addCost(c, TITLE_MODEL, usage, { countTask: false });
		const fresh = await getConversation(c.meta.id);
		if (fresh?.titleSource === "user") return; // renamed meanwhile
		if (text) c.meta.title = text.replace(/^["']|["'.]$/g, "").slice(0, 80);
		c.meta.titleSource = "auto";
	} catch {
		c.meta.titleSource = "first-message";
	}
	sync(c, true);
}
const TITLE_MODEL = "claude-haiku-5-5";

async function addCost(c, model, rawUsage, { countTask = false } = {}) {
	const prices = await getPrices();
	const price = priceFor(prices, model);
	const u = addUsage(emptyUsage(), rawUsage);
	const usd = price ? callCost(price, rawUsage) : null;
	c.meta.usd += usd || 0;
	c.meta.tokens += u.input + u.output + u.cacheRead + u.cacheWrite;
	if (countTask) await recordUsage(c.meta.site, usd, u);
	else await recordExtra(c.meta.site, usd, u);
}

// ---------- A turn ----------

// The system prompt and tools are fixed for a conversation's lifetime: changing them mid-way would
// invalidate the model's earlier reasoning and the cache. New settings/skills apply to new conversations.
async function freeze(c, tabId, origin, settings) {
	const [info, skills] = await Promise.all([siteInfo(tabId), getSkills(origin)]);
	c.frozen = {
		model: settings.model,
		allowChanges: settings.allowChanges,
		system: agentPrompt({ site: describeSite(info, origin), skills, allowChanges: settings.allowChanges }),
		tools: toolDefs({ skills, allowChanges: settings.allowChanges }),
	};
}

async function startTurn(tabId, text, voice) {
	const tab = await chrome.tabs.get(tabId);
	const url = new URL(tab.url);
	const origin = url.origin;
	const c = await convForTab(tabId, origin);
	if (c.busy || c.compacting) {
		c.queue.push({ text, voice, tabId });
		c.ui.push({ role: "user", text, queued: true });
		sync(c, true);
		return;
	}
	c.ui.push({ role: "user", text });
	c.busy = true;
	c.meta.updatedAt = Date.now();
	sync(c, true);

	const settings = await getSettings();
	try {
		if (!settings.anthropicKey) throw new Error("Add your Anthropic API key in ShowMe's settings (the gear icon) to get started.");
		if (!c.frozen) await freeze(c, tabId, origin, settings);
		const skills = await getSkills(origin);
		const mode = voice
			? "[Voice mode: everything you write is read aloud as you work. One short spoken sentence before each action, plain words, no tables, lists, markdown or symbols, no ref ids. Finish with one or two spoken sentences.]\n"
			: "";
		c.api.push({ role: "user", content: `[User is on: ${url.pathname}]\n${mode}${text}` });
		c.abort = new AbortController();
		const ctx = { tabId, s: c, settings: { ...settings, allowChanges: c.frozen.allowChanges }, origin, skills };
		const prices = await getPrices();
		const price = priceFor(prices, c.frozen.model);
		// usd stays null when the model has no known price: tokens are still counted.
		c.turn = { usage: emptyUsage(), calls: [], edits: 0, model: c.frozen.model, origin, price, usd: price ? 0 : null, source: prices.source, pricedAt: prices.fetchedAt };
		await runTurn({
			apiKey: settings.anthropicKey,
			model: c.frozen.model,
			system: c.frozen.system,
			tools: c.frozen.tools,
			messages: c.api,
			contextManagement: settings.devClearAt ? withTrigger(CONTEXT_EDITING, settings.devClearAt) : CONTEXT_EDITING,
			signal: c.abort.signal,
			onTextBlockStart: () => {
				c.ui.push({ role: "assistant", text: "" });
				sync(c);
			},
			onText: (d) => {
				const last = c.ui[c.ui.length - 1];
				if (last?.role === "assistant") last.text += d;
				else c.ui.push({ role: "assistant", text: d });
				sync(c);
			},
			onUsage: (u) => {
				addUsage(c.turn.usage, u);
				const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
				c.turn.calls.push(prompt);
				c.lastPrompt = prompt + (u.output_tokens || 0); // what the next request will at least carry
				if (c.turn.price) c.turn.usd += callCost(c.turn.price, u);
			},
			onEdits: (edits) => (c.turn.edits += edits.reduce((n, e) => n + (e.cleared_input_tokens || 0), 0)),
			executeTool: (name, input) => executeTool(ctx, name, input),
		});
	} catch (e) {
		repairHistory(c.api);
		c.ui.push(e.name === "AbortError" ? { role: "activity", text: "Stopped" } : { role: "assistant", text: `**Couldn't finish:** ${e.message}` });
	}
	if (c.turn?.usage.calls) {
		c.ui.push(costLine(c.turn));
		c.meta.usd += c.turn.usd || 0;
		c.meta.tokens += c.turn.usage.input + c.turn.usage.output + c.turn.usage.cacheRead + c.turn.usage.cacheWrite;
		await recordUsage(c.turn.origin, c.turn.usd, c.turn.usage);
	}
	c.turn = null;
	c.busy = false;
	c.abort = null;
	c.meta.updatedAt = Date.now();
	sync(c, true);

	if (settings.anthropicKey) {
		maybeTitle(c, settings); // in the background; doesn't block the next message
		c.compacting = maybeCompact(c, settings).finally(() => (c.compacting = null));
		await c.compacting;
	}
	const next = c.queue.shift();
	if (next) {
		const i = c.ui.findIndex((m) => m.queued && m.text === next.text);
		if (i >= 0) c.ui.splice(i, 1); // shown while queued; startTurn shows it again in order
		startTurn(next.tabId, next.text, next.voice);
	}
}

// ---------- Voice: create a GPT-Live session with the user's OpenAI key ----------

async function liveSession(tabId, sdp, resume) {
	const settings = await getSettings();
	if (!settings.openaiKey) return { error: "Add an OpenAI API key in ShowMe's settings to use voice." };
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

// ---------- Export ----------

function toMarkdown(c) {
	const out = [`# ${c.meta.title}`, "", `_${new URL(c.meta.site).host} · started ${new Date(c.meta.createdAt).toLocaleString()} · ${formatUSD(c.meta.usd) || "$0"} estimated_`, ""];
	let steps = [];
	const flush = () => {
		if (steps.length) out.push(`> Steps: ${steps.join(" → ")}`, "");
		steps = [];
	};
	for (const m of c.ui) {
		if (m.role === "activity") {
			steps.push(m.text);
			continue;
		}
		flush();
		if (m.role === "user") out.push(`**You:** ${m.text}`, "");
		else if (m.role === "assistant" && m.text.trim()) out.push(m.text.trim(), "");
		else if (m.role === "approval") out.push(`> **${m.title || "Approval"}** (${m.status}): ${m.summary || ""}`, "");
		else if (m.role === "cost") out.push(`_${m.text}_`, "");
		else if (m.role === "note") out.push(`_${m.text}_`, "");
	}
	flush();
	return out.join("\n");
}

// ---------- Messages from the page, the popup and the options page ----------

let pruned = false;
async function pruneOnce() {
	if (pruned) return;
	pruned = true;
	const { keepDays } = await getSettings();
	await prune(keepDays).catch(() => 0);
}

const metaOut = (m, currentId) => ({ id: m.id, title: m.title, updatedAt: m.updatedAt, pinned: m.pinned, usd: m.usd, current: m.id === currentId });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
	const tabId = sender.tab?.id ?? msg.tabId;
	const site = sender.tab?.url ? new URL(sender.tab.url).origin : msg.site;
	(async () => {
		switch (msg.kind) {
			case "hello": {
				pruneOnce();
				const c = await convForTab(tabId, site);
				const settings = await getSettings();
				return { list: c.ui, busy: c.busy, conv: { id: c.meta.id, title: c.meta.title }, hasKey: Boolean(settings.anthropicKey), hasVoice: Boolean(settings.openaiKey) };
			}
			case "heartbeat": // keeps this worker alive while a task or a voice call is running
				return { ok: true };
			case "chat": {
				const c = await convForTab(tabId, site);
				if (c.waiter) {
					const w = c.waiter;
					c.waiter = null;
					w({ type: "chat", text: msg.text });
				} else startTurn(tabId, msg.text, msg.voice);
				return { ok: true };
			}
			case "approve":
			case "reject": {
				const c = await convForTab(tabId, site);
				if (c.waiter) {
					const w = c.waiter;
					c.waiter = null;
					w({ type: msg.kind });
				}
				return { ok: true };
			}
			case "stop": {
				const c = await convForTab(tabId, site);
				c.queue = [];
				if (c.waiter) {
					const w = c.waiter;
					c.waiter = null;
					w({ type: "reject" });
				}
				c.abort?.abort();
				return { ok: true };
			}
			// ----- History -----
			case "new-chat": {
				const c = blankConv(site);
				convs.set(c.meta.id, c);
				await showInTab(tabId, c);
				return { ok: true };
			}
			case "list-conversations": {
				pruneOnce();
				const { [tabKey(tabId)]: currentId } = await chrome.storage.session.get(tabKey(tabId));
				return { items: (await listConversations(site)).map((m) => metaOut(m, currentId)) };
			}
			case "open-conversation": {
				const c = await loadConv(msg.id);
				if (!c) return { error: "That conversation no longer exists." };
				await showInTab(tabId, c);
				return { ok: true };
			}
			case "rename-conversation": {
				const title = String(msg.title || "").trim().slice(0, 80);
				if (!title) return { ok: false };
				const live = convs.get(msg.id);
				if (live) Object.assign(live.meta, { title, titleSource: "user" });
				await updateMeta(msg.id, { title, titleSource: "user" });
				if (live) sync(live, true);
				return { ok: true };
			}
			case "pin-conversation": {
				const live = convs.get(msg.id);
				const cur = live?.meta || (await getConversation(msg.id));
				const pinned = !cur?.pinned;
				if (live) live.meta.pinned = pinned;
				await updateMeta(msg.id, { pinned });
				return { ok: true, pinned };
			}
			case "delete-conversation": {
				const live = convs.get(msg.id);
				if (live?.busy) return { error: "Stop it first; it's still working." };
				convs.delete(msg.id);
				await deleteConversation(msg.id);
				const { [tabKey(tabId)]: currentId } = await chrome.storage.session.get(tabKey(tabId));
				if (currentId === msg.id) {
					const c = blankConv(site);
					convs.set(c.meta.id, c);
					await showInTab(tabId, c);
				}
				return { ok: true };
			}
			case "export-conversation": {
				const c = await loadConv(msg.id);
				if (!c) return { error: "Not found" };
				return { markdown: toMarkdown(c), filename: `${c.meta.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "conversation"}.md` };
			}
			case "delete-all-conversations": {
				for (const [id, c] of convs) if (!c.busy && (!msg.site || c.meta.site === msg.site) && (msg.includePinned || !c.meta.pinned)) convs.delete(id);
				return { deleted: await deleteAll({ site: msg.site || null, includePinned: Boolean(msg.includePinned) }) };
			}
			case "conversation-stats":
				return stats();
			// ----- Page helpers -----
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
