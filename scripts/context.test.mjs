// Context management check with low thresholds (dev overrides), so each path actually runs.
// Run once per mode: MODE=clear (context editing) and MODE=compact (compaction).
//   - context editing: old tool results get cleared server-side (reported on the cost line)
//   - compaction: between tasks the history is replaced by one signed summary block, the visible
//     transcript stays whole, and ShowMe still answers from what was summarised
//   ANTHROPIC_API_KEY=… ERP_URL=… node scripts/context.test.mjs
import { chromium } from "playwright";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { ANTHROPIC_API_KEY, ERP_URL, ERP_USER = "Administrator", ERP_PASS = "admin" } = process.env;
const origin = new URL(ERP_URL).origin;
const tmp = mkdtempSync(path.join(tmpdir(), "showme-ctx-"));
const ext = path.join(tmp, "extension");
cpSync(new URL("../extension", import.meta.url).pathname, ext, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push(`${origin}/*`);
writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest, null, 1));

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
	headless: false, viewport: null,
	args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--window-size=1440,920"],
});
try {
	const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
	const MODE = process.env.MODE || "compact";
	const dev = MODE === "clear" ? { devClearAt: 8000 } : { devCompactAt: 7000 };
	await sw.evaluate(async ([a, d]) => chrome.storage.local.set({ settings: { anthropicKey: a, model: "claude-sonnet-5-5", allowChanges: false, confirmRisky: true, ...d } }), [ANTHROPIC_API_KEY, dev]);
	const page = ctx.pages()[0] || (await ctx.newPage());
	await page.goto(`${origin}/login`, { waitUntil: "load" });
	await page.fill("#login_email", ERP_USER);
	await page.fill("#login_password", ERP_PASS);
	await page.press("#login_password", "Enter");
	await page.waitForURL(/\/(app|desk)/, { timeout: 30000 });
	await page.waitForSelector("#trainer-panel", { timeout: 20000 });

	const ask = async (text) => {
		const before = await page.$$eval(".tcost", (e) => e.length);
		await page.fill("#trainer-panel textarea", text);
		await page.press("#trainer-panel textarea", "Enter");
		await page.waitForFunction((n) => document.querySelectorAll(".tcost").length > n, before, { timeout: 240000 });
		await page.waitForTimeout(500);
		return page.$$eval(".tcost", (els) => {
			const e = els[els.length - 1];
			return { text: e.innerText, calls: (e.dataset.calls || "").split(",").filter(Boolean).map(Number), cleared: Number(e.dataset.cleared || 0) };
		});
	};

	const questions = ["How many customers do we have? Name them.", "Open the warehouse list so I can see where it lives.", "How many items are there?", "How many sales orders are there, by status?"];
	let cleared = 0;
	for (const q of questions) {
		const r = await ask(q);
		cleared += r.cleared;
		console.log(`  ${q}  calls=${JSON.stringify(r.calls)}  cleared=${r.cleared}  ${r.text}`);
		// Compaction runs right after a task; give it a moment before the next question.
		await page.waitForFunction(() => !document.querySelector("#trainer-msgs .cdx-shimmer"), null, { timeout: 120000 }).catch(() => {});
		await page.waitForTimeout(1500);
	}
	if (MODE === "clear") {
		check("context editing cleared old tool results server-side", cleared > 0, `${cleared} tokens cleared`);
		const last = await page.$$eval(".tcost", (els) => els.map((e) => e.innerText));
		check("caching stays high while clearing", last.every((t) => Number((t.match(/(\d+)% cached/) || [])[1] || 100) >= 75), last.map((t) => (t.match(/\d+% cached/) || [""])[0]).join(", "));
		throw "done"; // compaction checks don't apply in this mode
	}

	const notes = await page.$$eval(".tnote", (els) => els.map((e) => e.innerText));
	const condensed = notes.some((n) => /condensed/i.test(n));
	check("conversation was condensed between tasks", condensed, notes.join(" | ") || "no notes");

	const stored = await sw.evaluate(async () => {
		const db = await new Promise((res) => (indexedDB.open("showme").onsuccess = (e) => res(e.target.result)));
		const all = await new Promise((res) => (db.transaction("transcripts").objectStore("transcripts").getAll().onsuccess = (e) => res(e.target.result)));
		const t = all[0];
		return { firstBlock: t.api[0]?.content?.[0]?.type, apiLen: t.api.length, uiUsers: t.ui.filter((m) => m.role === "user").length };
	});
	check("model history starts with the signed compaction block", stored.firstBlock === "compaction", `first block: ${stored.firstBlock}, ${stored.apiLen} API messages`);
	check("visible transcript kept every message", stored.uiUsers === questions.length, `${stored.uiUsers} of ${questions.length} questions still shown`);

	const recall = await ask("From memory, without looking anything up: what was the first thing I asked you, and what was your answer?");
	const answer = await page.$$eval(".tmsg.assistant", (els) => els[els.length - 1]?.innerText || "");
	// Strict: the first request must come back in the user's words, with its answer.
	check("recalls the first request verbatim, and its answer", recall.calls.length === 1 && /how many customers do we have/i.test(answer) && /\b3\b|three/i.test(answer) && !/can.t be sure/i.test(answer), `${recall.calls.length} call(s): "${answer.slice(0, 160).replace(/\n/g, " ")}"`);
} catch (e) {
	if (e !== "done") check("test run", false, e.message);
} finally {
	await ctx.close();
	rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
