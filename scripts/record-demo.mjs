// Records the README demo: types a question into ShowMe and captures timed frames while it works.
// Use a demo site with no real data (e.g. frappe_docker + the setup wizard's demo data).
//   ANTHROPIC_API_KEY=… ERP_URL=http://127.0.0.1:8096 ASK="…" node scripts/record-demo.mjs
// Then: python3 scripts/make-gif.py /tmp/showme-frames docs/demo.gif   (needs Pillow)
import { chromium } from "playwright";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { ANTHROPIC_API_KEY, ERP_URL, ERP_USER = "Administrator", ERP_PASS = "admin" } = process.env;
const ASK = process.env.ASK || "I need to order 20 coffee mugs for the store. How do I raise a purchase request?";
const OUT = process.env.FRAMES || path.join(tmpdir(), "showme-frames");
const origin = new URL(ERP_URL).origin;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(path.join(tmpdir(), "showme-rec-"));
const ext = path.join(tmp, "extension");
cpSync(new URL("../extension", import.meta.url).pathname, ext, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push(`${origin}/*`);
writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest, null, 1));

const ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
	headless: false,
	viewport: { width: 1440, height: 860 },
	args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const frames = [];
let recording = true;
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
	await page.waitForTimeout(2500); // fonts, sidebar settle

	// Capture loop: screenshot as fast as the page allows (~6-10 fps), with real timestamps.
	const t0 = Date.now();
	const capture = (async () => {
		while (recording) {
			const file = path.join(OUT, `${String(frames.length).padStart(5, "0")}.jpg`);
			await page.screenshot({ path: file, type: "jpeg", quality: 85 }).catch(() => {});
			frames.push({ file, t: Date.now() - t0 });
		}
	})();

	await page.waitForTimeout(1200);
	await page.click("#trainer-panel textarea");
	await page.keyboard.type(ASK, { delay: 35 }); // visible typing
	await page.waitForTimeout(500);
	await page.keyboard.press("Enter");
	// Done when the task's cost line appears, then hold on the result.
	await page.waitForSelector(".tcost", { timeout: 300000 });
	await page.waitForTimeout(3500);
	recording = false;
	await capture;
	writeFileSync(path.join(OUT, "frames.json"), JSON.stringify(frames));
	console.log(`${frames.length} frames over ${(frames.at(-1).t / 1000).toFixed(1)}s -> ${OUT}`);
	console.log("answer:", (await page.$$eval(".tmsg.assistant", (e) => e.at(-1)?.innerText || "")).slice(0, 300));
	console.log("cost:", await page.$eval(".tcost", (e) => e.innerText));
} finally {
	recording = false;
	await ctx.close();
	rmSync(tmp, { recursive: true, force: true });
}
