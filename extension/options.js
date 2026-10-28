// Settings page: keys, models, safety switches, skills (SKILL.md files), sites, change log.
const $ = (id) => document.getElementById(id);
const DEFAULTS = {
	anthropicKey: "", openaiKey: "", model: "claude-sonnet-5-5", voiceModel: "gpt-live-1", voice: "marin",
	allowChanges: false, confirmRisky: true,
};
const FIELDS = ["anthropicKey", "openaiKey", "model", "voiceModel", "voice"];
const CHECKS = ["allowChanges", "confirmRisky"];
const API_ORIGINS = ["https://api.anthropic.com/*", "https://api.openai.com/*"];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------- Settings ----------

const settings = { ...DEFAULTS, ...((await chrome.storage.local.get("settings")).settings || {}) };
for (const k of FIELDS) $(k).value = settings[k];
for (const k of CHECKS) $(k).checked = settings[k];

$("save").onclick = async () => {
	for (const k of FIELDS) settings[k] = $(k).value.trim();
	for (const k of CHECKS) settings[k] = $(k).checked;
	await chrome.storage.local.set({ settings });
	$("saved").classList.add("show");
	setTimeout(() => $("saved").classList.remove("show"), 1500);
};

// ---------- Sites ----------

async function siteOrigins() {
	const { origins = [] } = await chrome.permissions.getAll();
	return origins.filter((o) => !API_ORIGINS.includes(o)).map((o) => o.replace(/\/\*$/, ""));
}

async function renderSites() {
	const sites = await siteOrigins();
	$("sites").innerHTML = sites.length ? "" : `<p class="muted">None yet.</p>`;
	for (const origin of sites) {
		const row = document.createElement("div");
		row.className = "row";
		row.style.justifyContent = "space-between";
		row.innerHTML = `<code>${esc(origin)}</code>`;
		const off = document.createElement("button");
		off.textContent = "Remove";
		off.onclick = async () => {
			await chrome.permissions.remove({ origins: [`${origin}/*`] });
			renderSites();
			renderSkills();
		};
		row.append(off);
		$("sites").append(row);
	}
}

// ---------- Skills ----------

// Parse optional YAML-ish frontmatter (name, description); fall back to the file name / first heading.
function parseSkill(text, fileName = "") {
	let body = text.replace(/^﻿/, "");
	const meta = {};
	const fm = body.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
	if (fm) {
		for (const line of fm[1].split("\n")) {
			const m = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
			if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, "");
		}
		body = body.slice(fm[0].length);
	}
	const heading = body.match(/^#\s+(.+)$/m)?.[1];
	const firstPara = body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#"));
	return {
		id: crypto.randomUUID(),
		name: meta.name || fileName.replace(/\.(md|markdown|txt)$/i, "").replace(/^SKILL$/i, "") || heading || "untitled-skill",
		description: meta.description || (firstPara || "").slice(0, 200),
		content: body.trim(),
		scope: "*",
		enabled: true,
	};
}

async function getSkills() {
	return (await chrome.storage.local.get("skills")).skills || [];
}
async function saveSkills(skills) {
	await chrome.storage.local.set({ skills });
	renderSkills();
}

async function addSkills(list) {
	const skills = await getSkills();
	for (const sk of list) {
		const i = skills.findIndex((x) => x.name === sk.name && x.scope === sk.scope);
		if (i >= 0) skills[i] = { ...skills[i], ...sk, id: skills[i].id }; // same name: replace
		else skills.push(sk);
	}
	await saveSkills(skills);
}

async function renderSkills() {
	const [skills, sites] = await Promise.all([getSkills(), siteOrigins()]);
	$("skills").innerHTML = skills.length ? "" : `<p class="muted" style="margin-top:8px">No skills yet.</p>`;
	for (const sk of skills) {
		const row = document.createElement("div");
		row.className = "skill";
		row.innerHTML = `
			<input type="checkbox" ${sk.enabled !== false ? "checked" : ""} title="Enabled" style="margin-top:4px;accent-color:var(--brand)">
			<div class="meta"><b>${esc(sk.name)}</b> <span class="muted" style="font-size:12px">${sk.content.length.toLocaleString()} chars</span>
				<div class="desc">${esc(sk.description)}</div></div>
			<select style="width:200px"><option value="*">All sites</option>${sites
				.map((o) => `<option value="${esc(o)}" ${sk.scope === o ? "selected" : ""}>${esc(new URL(o).host)}</option>`)
				.join("")}</select>
			<button class="link">Remove</button>`;
		const [check, , scope, remove] = row.children;
		if (sk.scope !== "*" && !sites.includes(sk.scope)) scope.insertAdjacentHTML("beforeend", `<option value="${esc(sk.scope)}" selected>${esc(sk.scope)}</option>`);
		check.onchange = async () => saveSkills((await getSkills()).map((x) => (x.id === sk.id ? { ...x, enabled: check.checked } : x)));
		scope.onchange = async () => saveSkills((await getSkills()).map((x) => (x.id === sk.id ? { ...x, scope: scope.value } : x)));
		remove.onclick = async () => saveSkills((await getSkills()).filter((x) => x.id !== sk.id));
		$("skills").append(row);
	}
}

async function readFiles(files) {
	const list = [];
	for (const f of files) list.push(parseSkill(await f.text(), f.name));
	await addSkills(list);
}
$("drop").onclick = () => $("file").click();
$("file").onchange = () => readFiles($("file").files);
$("drop").ondragover = (e) => {
	e.preventDefault();
	$("drop").classList.add("over");
};
$("drop").ondragleave = () => $("drop").classList.remove("over");
$("drop").ondrop = (e) => {
	e.preventDefault();
	$("drop").classList.remove("over");
	readFiles(e.dataTransfer.files);
};
$("addPaste").onclick = async () => {
	const text = $("paste").value.trim();
	if (!text) return;
	await addSkills([parseSkill(text)]);
	$("paste").value = "";
};

// ---------- Change log ----------

async function renderChanges() {
	const all = await chrome.storage.local.get(null);
	const keys = Object.keys(all).filter((k) => k.startsWith("changes:") && all[k].length);
	$("changes").innerHTML = keys.length ? "" : `<p class="muted">None.</p>`;
	for (const k of keys) {
		const origin = k.slice("changes:".length);
		const box = document.createElement("div");
		box.innerHTML = `<b style="font-weight:500">${esc(new URL(origin).host)}</b>${all[k]
			.slice()
			.reverse()
			.map((c) => `<div class="change"><code>${esc(c.doctype)}</code> ${esc(c.name)} <span class="muted">· ${esc(c.summary)} · ${new Date(c.at).toLocaleString()}</span></div>`)
			.join("")}`;
		$("changes").append(box);
	}
}

// ---------- Usage ----------

const usd = (n) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

async function renderUsage() {
	const { usage = {} } = await chrome.storage.local.get("usage");
	const months = Object.keys(usage).sort().reverse();
	if (!months.length) return ($("usage").innerHTML = `<p class="muted">Nothing yet.</p>`);
	$("usage").innerHTML = months
		.map((mo) => {
			const m = usage[mo];
			const label = new Date(`${mo}-01T00:00:00`).toLocaleString(undefined, { month: "long", year: "numeric" });
			const sites = Object.entries(m.sites || {})
				.sort((a, b) => b[1].usd - a[1].usd)
				.map(([o, v]) => `<div class="change"><code>${esc(new URL(o).host)}</code> <span class="muted">· ${v.tasks} task${v.tasks === 1 ? "" : "s"} · ${usd(v.usd)}</span></div>`)
				.join("");
			const voice = m.voiceSeconds ? ` · voice ${Math.round(m.voiceSeconds / 60)} min (billed by OpenAI)` : "";
			const unpriced = m.unpriced ? ` · ${tok(m.unpriced)} tokens on models without a price` : "";
			return `<div style="margin-top:8px"><b style="font-weight:500">${label}: ${usd(m.usd)}</b>
				<span class="muted"> · ${m.tasks} task${m.tasks === 1 ? "" : "s"} · ${tok(m.tokens)} tokens${voice}${unpriced}</span>${sites}</div>`;
		})
		.join("");
}
$("resetUsage").onclick = async () => {
	if (!confirm("Reset the usage totals? This doesn't affect your provider bills.")) return;
	await chrome.storage.local.remove("usage");
	renderUsage();
};

async function renderPriceSource(force = false) {
	const p = await chrome.runtime.sendMessage({ kind: "prices", force });
	$("priceSource").textContent = p?.fetchedAt
		? `Prices: ${p.source} (${p.models.toLocaleString()} models), updated ${new Date(p.fetchedAt).toLocaleString()}`
		: `Prices: ${p?.source || "unavailable"}`;
}
$("refreshPrices").onclick = () => renderPriceSource(true);

renderSites();
renderSkills();
renderChanges();
renderUsage();
renderPriceSource();
