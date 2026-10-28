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
const LAYOUT = "cursor"; // the only layout; kept for the log line
const origin = new URL(ERP_URL).origin;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(path.join(tmpdir(), "showme-rec-"));
const ext = path.join(tmp, "extension");
cpSync(new URL("../extension", import.meta.url).pathname, ext, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push(`${origin}/*`);
writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest, null, 1));
if (process.env.DEBUG_EMIT) {
	// Log every message ShowMe sends, with the event that triggered it (to chase stray sends).
	const cp = path.join(ext, "content.js");
	writeFileSync(cp, readFileSync(cp, "utf8").replace("const emit = (evt) => {", "const emit = (evt) => { console.log('EMIT ' + JSON.stringify(evt) + ' | event=' + (window.event && (window.event.type + ':' + window.event.isTrusted + ':' + (window.event.key || '') + ':' + (window.event.target && (window.event.target.className || window.event.target.tagName)))) + ' | ' + new Error().stack.split('\\n').slice(2, 4).join(' <- '));"));
}

const ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
	headless: false,
	viewport: { width: 1440, height: 860 },
	args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const frames = [];
let recording = true;
try {
	const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
	await sw.evaluate(async ([a, l]) => chrome.storage.local.set({ settings: { anthropicKey: a, model: "claude-sonnet-5-5", allowChanges: false, confirmRisky: true } }), [ANTHROPIC_API_KEY, LAYOUT]);
	const page = ctx.pages()[0] || (await ctx.newPage());
	if (process.env.DEBUG_EMIT) page.on("console", (m) => m.text().startsWith("EMIT") && console.log(m.text().slice(0, 300)));
	await page.goto(`${origin}/login`, { waitUntil: "load" });
	await page.fill("#login_email", ERP_USER);
	await page.fill("#login_password", ERP_PASS);
	await page.press("#login_password", "Enter");
	await page.waitForURL(/\/(app|desk)/, { timeout: 30000 });
	await page.waitForSelector("#t-bar input", { state: "visible", timeout: 20000 });
	await page.waitForTimeout(2500); // fonts, layout settle

	const userMsgs = () => page.evaluate(() => [...document.querySelectorAll("#trainer-msgs .tmsg.user")].map((e) => e.textContent));
	if (process.env.DEBUG) console.log("before capture, user messages:", JSON.stringify(await userMsgs()));
	// Capture loop: screenshots at ~12 fps with real timestamps.
	const t0 = Date.now();
	const capture = (async () => {
		while (recording) {
			const file = path.join(OUT, `${String(frames.length).padStart(5, "0")}.jpg`);
			await page.screenshot({ path: file, type: "jpeg", quality: 85 }).catch(() => {});
			frames.push({ file, t: Date.now() - t0 });
			await new Promise((r) => setTimeout(r, 50)); // ~12 fps is plenty; back-to-back screenshots were linked to stray clicks
		}
	})();

	await page.waitForTimeout(1200);
	await page.click("#t-bar input");
	await page.mouse.move(200, 200); // park the real mouse away from ShowMe's bar
	await page.keyboard.type(ASK, { delay: 35 }); // visible typing
	await page.waitForTimeout(500);
	await page.keyboard.press("Enter");
	if (process.env.DEBUG) {
		await page.waitForTimeout(800);
		console.log("after Enter, user messages:", JSON.stringify(await userMsgs()));
	}
	// While it works, measure: distance from ShowMe's cursor to the text narrating it, and how much of
	// the screen ShowMe's own UI covers.
	const samples = [];
	const measuring = (async () => {
		while (recording) {
			const m = await page.evaluate(() => {
				const cur = document.querySelector("#trainer-cursor");
				if (!cur || cur.style.display !== "block") return null;
				const c = cur.getBoundingClientRect();
				const px = c.left + 4, py = c.top + 4;
				const sayEl = document.querySelector("#t-say.on");
				const items = [...document.querySelectorAll("#trainer-msgs > *")];
				const narr = sayEl || (!document.querySelector("#trainer-panel.closed") && items[items.length - 1]);
				if (!narr) return null;
				const r = narr.getBoundingClientRect();
				const dx = Math.max(r.left - px, 0, px - r.right), dy = Math.max(r.top - py, 0, py - r.bottom);
				const area = (e) => {
					if (!e || e.hidden || e.classList?.contains("closed")) return 0;
					const b = e.getBoundingClientRect();
					return b.width * b.height;
				};
				const ui = area(document.querySelector("#trainer-panel")) + area(document.querySelector("#t-bar")) + area(sayEl);
				return { dist: Math.round(Math.hypot(dx, dy)), cover: ui / (innerWidth * innerHeight) };
			}).catch(() => null);
			if (m) samples.push(m);
			await new Promise((r) => setTimeout(r, 400));
		}
	})();
	// Done when the task's cost line appears, then hold on the result.
	await page.waitForSelector(".tcost", { state: "attached", timeout: 300000 });
	await page.waitForTimeout(3500);
	recording = false;
	await capture;
	await measuring;
	const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
	if (samples.length)
		console.log(`layout=${LAYOUT}: narration-to-cursor distance median ${med(samples.map((s) => s.dist))}px; ShowMe covers median ${(med(samples.map((s) => s.cover)) * 100).toFixed(0)}% of the screen (${samples.length} samples)`);
	writeFileSync(path.join(OUT, "frames.json"), JSON.stringify(frames));
	console.log(`${frames.length} frames over ${(frames.at(-1).t / 1000).toFixed(1)}s -> ${OUT}`);
	console.log("answer:", (await page.$$eval(".tmsg.assistant", (e) => e.at(-1)?.textContent || "")).slice(0, 300));
	console.log("cost:", await page.$eval(".tcost", (e) => e.textContent));
} finally {
	recording = false;
	await ctx.close();
	rmSync(tmp, { recursive: true, force: true });
}
