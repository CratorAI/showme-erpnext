// End-to-end check: loads the extension into Playwright's Chromium with a throwaway profile, logs in
// to an ERPNext, sends one message through the real sidebar and prints the transcript.
//
//   ANTHROPIC_API_KEY=… ERP_URL=http://localhost:8080 ERP_USER=Administrator ERP_PASS=admin \
//   ASK="Show me last month's sales invoices" node scripts/e2e.mjs
//
// Optional: OPENAI_API_KEY, ALLOW_CHANGES=1, APPROVE=1 / REJECT=1 (answer approval cards), ASK2 (follow-up).
// Uses a temporary copy of the extension whose manifest pre-grants ERP_URL, because automation
// can't click Chrome's native permission prompt.
import { chromium } from "playwright";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { ANTHROPIC_API_KEY, OPENAI_API_KEY = "", ERP_URL, ERP_USER = "Administrator", ERP_PASS = "admin" } = process.env;
const ASK = process.env.ASK || "What can you help me with on this page?";
if (!ANTHROPIC_API_KEY || !ERP_URL) {
	console.error("Set ANTHROPIC_API_KEY and ERP_URL (and ERP_USER / ERP_PASS).");
	process.exit(2);
}
const origin = new URL(ERP_URL).origin;

const tmp = mkdtempSync(path.join(tmpdir(), "showme-e2e-"));
const ext = path.join(tmp, "extension");
cpSync(new URL("../extension", import.meta.url).pathname, ext, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push(`${origin}/*`);
writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest, null, 1));

const ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
	headless: false,
	viewport: null,
	args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--window-size=1440,920"],
});
try {
	const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
	await sw.evaluate(
		async ([a, o, allow]) =>
			chrome.storage.local.set({
				settings: { anthropicKey: a, openaiKey: o, model: "claude-sonnet-5-5", voiceModel: "gpt-live-1", voice: "marin", allowChanges: allow, confirmRisky: true },
			}),
		[ANTHROPIC_API_KEY, OPENAI_API_KEY, Boolean(process.env.ALLOW_CHANGES)]
	);

	const page = ctx.pages()[0] || (await ctx.newPage());
	await page.goto(`${origin}/login`, { waitUntil: "load" });
	await page.fill("#login_email", ERP_USER);
	await page.fill("#login_password", ERP_PASS);
	await page.press("#login_password", "Enter");
	await page.waitForURL(/\/(app|desk)/, { timeout: 30000 });
	await page.waitForSelector("#trainer-panel", { timeout: 20000 });

	for (const text of [ASK, process.env.ASK2].filter(Boolean)) {
		await page.fill("#trainer-panel textarea", text);
		await page.press("#trainer-panel textarea", "Enter");
		await page.waitForTimeout(2500);
		const t0 = Date.now();
		while (Date.now() - t0 < 240000) {
			if (process.env.APPROVE && (await page.$(".tapprove.pending .btn"))) await page.click(".tapprove.pending .btn");
			if (process.env.REJECT && (await page.$(".tapprove.pending .lnk"))) await page.click(".tapprove.pending .lnk");
			if (!(await page.evaluate(() => document.querySelector("#trainer-panel .send")?.title === "Stop"))) break;
			await page.waitForTimeout(1500);
		}
		console.log(`--- ${text} (${Math.round((Date.now() - t0) / 1000)}s)`);
	}
	await page.screenshot({ path: path.join(tmpdir(), "showme-e2e.png") });
	console.log(
		(await page.evaluate(() => [...document.querySelectorAll("#trainer-msgs > *")].map((e) => "• " + e.innerText.replace(/\n+/g, " | ")).join("\n")))
	);
	console.log(`screenshot: ${path.join(tmpdir(), "showme-e2e.png")}`);
	const sw2 = ctx.serviceWorkers()[0];
	if (sw2) console.log("usage totals:", JSON.stringify(await sw2.evaluate(() => chrome.storage.local.get("usage").then((x) => x.usage))));
	console.log("cost tooltip:", await page.evaluate(() => document.querySelector(".tcost")?.title));
	console.log("error dialog on screen:", await page.evaluate(() => Boolean(document.querySelector(".modal.show .msgprint"))));
	if (sw2) console.log("price source:", JSON.stringify(await sw2.evaluate(() => chrome.storage.local.get("prices").then((x) => x.prices && { source: x.prices.source, fetchedAt: new Date(x.prices.fetchedAt).toISOString(), sonnet: x.prices.table["claude-sonnet-5-5"] }))));
} finally {
	await ctx.close();
	rmSync(tmp, { recursive: true, force: true });
}
