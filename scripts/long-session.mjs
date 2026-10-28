// Long-session measurement: one conversation, many read-only questions, recording the prompt size
// (tokens the model read) of every API call and the cost of every task. Used to tune context
// management. Same env as e2e.mjs. Writes a JSON report to $OUT (default /tmp/showme-long-session.json).
//   ANTHROPIC_API_KEY=… ERP_URL=… node scripts/long-session.mjs
import { chromium } from "playwright";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { ANTHROPIC_API_KEY, ERP_URL, ERP_USER = "Administrator", ERP_PASS = "admin" } = process.env;
const OUT = process.env.OUT || path.join(tmpdir(), "showme-long-session.json");
const N = Number(process.env.TURNS || 30);
const QUESTIONS = [
	"How many customers do we have?", "How many suppliers?", "Which item groups exist?", "How many items are there?",
	"Show me where the list of warehouses lives.", "How many warehouses do we have?", "How many sales orders are there?",
	"Which customer has the most sales orders?", "How many of those are drafts?", "How many sales invoices exist?",
	"What's the total of all sales invoices?", "How many purchase orders are there?", "Which supplier do we buy from most?",
	"How many material requests are open?", "Show me where Purchase Receipts live.", "How many work orders are there?",
	"How many BOMs are there?", "Which company is the default?", "What currency do we use?", "How many users are there?",
	"Show me the stock balance report.", "Which item has the most stock?", "How many delivery notes exist?",
	"How many payment entries are there?", "Which customer owes us the most?", "How many journal entries are there?",
	"What was the first question I asked you today?", "Summarise what we've looked at so far in one line.",
	"How many quotations are there?", "Thanks, that's all.",
].slice(0, N);

const origin = new URL(ERP_URL).origin;
const tmp = mkdtempSync(path.join(tmpdir(), "showme-long-"));
const ext = path.join(tmp, "extension");
cpSync(new URL("../extension", import.meta.url).pathname, ext, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push(`${origin}/*`);
writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest, null, 1));

const ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
	headless: false, viewport: null,
	args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--window-size=1440,920"],
});
const report = { turns: [] };
try {
	const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
	await sw.evaluate(async (a) => chrome.storage.local.set({ settings: { anthropicKey: a, model: "claude-sonnet-5-5", allowChanges: false, confirmRisky: true } }), ANTHROPIC_API_KEY);
	const page = ctx.pages()[0] || (await ctx.newPage());
	await page.goto(`${origin}/login`, { waitUntil: "load" });
	await page.fill("#login_email", ERP_USER);
	await page.fill("#login_password", ERP_PASS);
	await page.press("#login_password", "Enter");
	await page.waitForURL(/\/(app|desk)/, { timeout: 30000 });
	await page.waitForSelector("#trainer-panel", { timeout: 20000 });
	for (const [i, q] of QUESTIONS.entries()) {
		const before = await page.$$eval(".tcost", (els) => els.length);
		await page.fill("#trainer-panel textarea", q);
		await page.press("#trainer-panel textarea", "Enter");
		const t0 = Date.now();
		await page.waitForFunction((n) => document.querySelectorAll(".tcost").length > n, before, { timeout: 240000 }).catch(() => {});
		const last = await page.$$eval(".tcost", (els) => {
			const e = els[els.length - 1];
			return e && { text: e.innerText, calls: (e.dataset.calls || "").split(",").filter(Boolean).map(Number) };
		});
		const answer = await page.$$eval(".tmsg.assistant", (els) => (els[els.length - 1]?.innerText || "").slice(0, 160));
		report.turns.push({ i: i + 1, q, secs: Math.round((Date.now() - t0) / 1000), cost: last?.text, calls: last?.calls, answer });
		console.log(`${String(i + 1).padStart(2)} ${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s  calls=${JSON.stringify(last?.calls)}  ${last?.text}`);
		writeFileSync(OUT, JSON.stringify(report, null, 1));
	}
} finally {
	await ctx.close();
	rmSync(tmp, { recursive: true, force: true });
}
console.log(`report: ${OUT}`);
