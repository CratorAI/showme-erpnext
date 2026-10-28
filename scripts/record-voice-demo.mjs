// Records a voice demo: plays pre-recorded lines into ShowMe's microphone at the right moments of a real voice
// call, and captures timed screenshots plus both voices (the lines and ShowMe's replies) in one audio track.
// Use a demo site with no real data.
//
//   ANTHROPIC_API_KEY=… OPENAI_API_KEY=… ERP_URL=http://127.0.0.1:8096 \
//   LINES=/path/line1.wav,/path/line2.wav OUT=/tmp/showme-voice node scripts/record-voice-demo.mjs
//
// Writes OUT/frames/*.jpg + frames.json (timestamps), OUT/audio.webm and OUT/timeline.json (when the audio and
// each line started, in ms from the first frame). Each line is played once ShowMe has finished and handed the
// turn back. Assemble with: python3 scripts/make-voice-video.py OUT docs/voice-demo.mp4 [--avatar clip.webm …]
import { chromium } from "playwright";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { ANTHROPIC_API_KEY, OPENAI_API_KEY, ERP_URL, ERP_USER = "Administrator", ERP_PASS = "admin" } = process.env;
const LINES = (process.env.LINES || "").split(",").filter(Boolean);
const OUT = process.env.OUT || path.join(tmpdir(), "showme-voice");
if (!ANTHROPIC_API_KEY || !OPENAI_API_KEY || !ERP_URL || !LINES.length) {
	console.error("Set ANTHROPIC_API_KEY, OPENAI_API_KEY, ERP_URL and LINES (comma-separated .wav files).");
	process.exit(2);
}
const origin = new URL(ERP_URL).origin;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, "frames"), { recursive: true });
const tmp = mkdtempSync(path.join(tmpdir(), "showme-vrec-"));
const ext = path.join(tmp, "extension");
cpSync(new URL("../extension", import.meta.url).pathname, ext, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push(`${origin}/*`);
writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest, null, 1));

// Demo hooks, in this temporary copy only: a virtual microphone fed from <html data-demo-clip>, a tap on
// ShowMe's voice, and a recorder that mixes both. Driven by DOM events, which cross into the isolated world.
const HOOKS = `
const __demo = (() => {
	let ctx, mic, mix, rec, chunks = [];
	const ensure = () => {
		if (ctx) return;
		ctx = new AudioContext();
		mic = ctx.createMediaStreamDestination();
		mix = ctx.createMediaStreamDestination();
	};
	const el = document.documentElement;
	document.addEventListener("showme-demo-play", async () => {
		ensure();
		const bytes = Uint8Array.from(atob(el.dataset.demoClip), (c) => c.charCodeAt(0));
		const buf = await ctx.decodeAudioData(bytes.buffer);
		const s = ctx.createBufferSource();
		s.buffer = buf;
		s.connect(mic);
		s.connect(mix);
		s.start();
		el.dataset.demoPlayedAt = String(Date.now());
		el.dataset.demoPlayEnds = String(Date.now() + Math.round(buf.duration * 1000));
	});
	document.addEventListener("showme-demo-rec", () => {
		ensure();
		rec = new MediaRecorder(mix.stream, { mimeType: "audio/webm;codecs=opus" });
		rec.ondataavailable = (e) => chunks.push(e.data);
		rec.start(1000);
		el.dataset.demoRecAt = String(Date.now());
	});
	document.addEventListener("showme-demo-stop", () => {
		rec.onstop = async () => {
			const b = new Uint8Array(await new Blob(chunks, { type: "audio/webm" }).arrayBuffer());
			let s = "";
			for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
			el.dataset.demoAudio = btoa(s);
		};
		rec.stop();
	});
	return {
		getMic: async () => (ensure(), mic.stream),
		tapOut: (stream) => (ensure(), ctx.createMediaStreamSource(stream).connect(mix)),
	};
})();
`;
const cp = path.join(ext, "content.js");
let src = readFileSync(cp, "utf8");
const patch = (a, b) => {
	if (!src.includes(a)) throw new Error(`content.js changed; demo hook point not found: ${a}`);
	src = src.replace(a, b);
};
patch("(() => {\n\tif (window.__trainer) return;", `(() => {\n\tif (window.__trainer) return;\n${HOOKS}`);
patch("const stream = await navigator.mediaDevices.getUserMedia({", "const stream = await __demo.getMic({");
patch("pc.ontrack = (e) => {", "pc.ontrack = (e) => {\n\t\t\t\t__demo.tapOut(e.streams[0]);");
writeFileSync(cp, src);

const ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
	headless: false,
	viewport: { width: 1440, height: 860 },
	args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--autoplay-policy=no-user-gesture-required"],
});
const frames = [];
let recording = false;
try {
	const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
	await sw.evaluate(([a, o]) => chrome.storage.local.set({ settings: { anthropicKey: a, openaiKey: o, model: "claude-sonnet-5-5", voiceModel: "gpt-live-1", voice: "marin", allowChanges: false, confirmRisky: true } }), [ANTHROPIC_API_KEY, OPENAI_API_KEY]);
	const page = ctx.pages()[0] || (await ctx.newPage());
	if (process.env.DEBUG) page.on("console", (m) => m.text().startsWith("[live]") && !m.text().includes("usage") && console.log("  ", m.text().slice(0, 160)));
	await page.goto(`${origin}/login`, { waitUntil: "load" });
	await page.fill("#login_email", ERP_USER);
	await page.fill("#login_password", ERP_PASS);
	await page.press("#login_password", "Enter");
	await page.waitForURL(/\/(app|desk)/, { timeout: 30000 });
	await page.waitForSelector("#t-bar input", { state: "visible", timeout: 20000 });
	await page.waitForTimeout(2000);

	const turn = () => page.evaluate(() => document.querySelector("#t-bar .call")?.dataset.turn || "");
	const dom = (k) => page.evaluate((k) => document.documentElement.dataset[k], k);
	const fire = (name) => page.evaluate((n) => document.dispatchEvent(new Event(n)), name);

	// Frames from here on, with real timestamps.
	recording = true;
	const t0 = Date.now();
	const capture = (async () => {
		while (recording) {
			const file = path.join(OUT, "frames", `${String(frames.length).padStart(5, "0")}.jpg`);
			await page.screenshot({ path: file, type: "jpeg", quality: 88 }).catch(() => {});
			frames.push({ file, t: Date.now() - t0 });
			await new Promise((r) => setTimeout(r, 50));
		}
	})();

	// Start the call like a person would, then rest the mouse where the "you" ring reads well.
	await page.waitForTimeout(1200);
	await page.click('#t-bar [data-a="voice"]');
	await page.mouse.move(1010, 470, { steps: 12 });
	const t1 = Date.now();
	while ((await turn()) !== "wait" && Date.now() - t1 < 20000) await page.waitForTimeout(200);
	await fire("showme-demo-rec");
	await page.waitForTimeout(1500);

	const timeline = { audioAt: Number(await dom("demoRecAt")) - t0, lines: [] };
	for (const [i, file] of LINES.entries()) {
		await page.evaluate((b64) => (document.documentElement.dataset.demoClip = b64), readFileSync(file).toString("base64"));
		await fire("showme-demo-play");
		await page.waitForFunction(() => document.documentElement.dataset.demoPlayedAt, null, { timeout: 5000 });
		const at = Number(await dom("demoPlayedAt")), ends = Number(await dom("demoPlayEnds"));
		timeline.lines.push({ file, at: at - t0, ms: ends - at });
		console.log(`line ${i + 1} at ${((at - t0) / 1000).toFixed(1)}s`);
		await page.evaluate(() => delete document.documentElement.dataset.demoPlayedAt);
		// Wait until the agent has finished, ShowMe has spoken after that (the answer), and the turn has been back
		// with the user, quietly, for 2.5 s. Pauses between steps don't count: the agent is still busy then.
		const busy = () => page.evaluate(() => document.querySelector("#t-bar .go")?.title === "Stop");
		const t = Date.now();
		let wasBusy = false, lastBusy = 0, spokeAfter = false, quietSince = 0;
		while (Date.now() - t < 240000) {
			const [tn, b] = [await turn(), await busy()];
			if (b) (wasBusy = true), (lastBusy = Date.now()), (spokeAfter = false);
			else if (wasBusy && tn === "them") spokeAfter = true;
			if (wasBusy && spokeAfter && !b && tn === "wait" && Date.now() > ends) quietSince ||= Date.now();
			else quietSince = 0;
			if (quietSince && Date.now() - quietSince > 2500) break;
			if (!wasBusy && Date.now() - t > 30000) throw new Error(`No response to line ${i + 1} within 30 s (was it loud enough? normalise it, e.g. ffmpeg -af loudnorm)`);
			await page.waitForTimeout(250);
		}
		console.log(`  ShowMe done at ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	}
	await page.waitForTimeout(1000);
	await fire("showme-demo-stop");
	await page.waitForFunction(() => document.documentElement.dataset.demoAudio, null, { timeout: 15000 });
	writeFileSync(path.join(OUT, "audio.webm"), Buffer.from(await dom("demoAudio"), "base64"));
	recording = false;
	await capture;
	writeFileSync(path.join(OUT, "frames.json"), JSON.stringify(frames.map((f) => ({ file: path.basename(f.file), t: f.t }))));
	writeFileSync(path.join(OUT, "timeline.json"), JSON.stringify(timeline, null, 1));
	console.log(`${frames.length} frames over ${(frames.at(-1).t / 1000).toFixed(1)}s, audio from ${(timeline.audioAt / 1000).toFixed(1)}s -> ${OUT}`);
	console.log("transcript:", (await page.$$eval("#trainer-msgs .tmsg", (e) => e.map((x) => `${x.classList.contains("user") ? "USER" : "SHOWME"}: ${x.textContent.trim().slice(0, 160)}`))).join("\n"));
} finally {
	recording = false;
	await ctx.close();
	rmSync(tmp, { recursive: true, force: true });
}
