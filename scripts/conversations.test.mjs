// Conversation management checks, against a real ERPNext, in Playwright's Chromium:
//   1. persistence: a conversation survives closing the browser, and ShowMe answers from it without
//      looking anything up again
//   2. storage: 100 saved conversations stay well under quota and the History list opens fast
//   3. setup memory: a fact is only saved after Remember, and what's saved is what the card showed;
//      declining saves nothing
//   ANTHROPIC_API_KEY=… ERP_URL=… node scripts/conversations.test.mjs
import { chromium } from "playwright";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { ANTHROPIC_API_KEY, ERP_URL, ERP_USER = "Administrator", ERP_PASS = "admin" } = process.env;
const origin = new URL(ERP_URL).origin;
const tmp = mkdtempSync(path.join(tmpdir(), "showme-conv-"));
const ext = path.join(tmp, "extension");
const profile = path.join(tmp, "profile");
cpSync(new URL("../extension", import.meta.url).pathname, ext, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push(`${origin}/*`);
writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest, null, 1));

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function launch() {
	const ctx = await chromium.launchPersistentContext(profile, {
		headless: false, viewport: null,
		args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--window-size=1440,920"],
	});
	const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
	await sw.evaluate(async (a) => {
		const { settings } = await chrome.storage.local.get("settings");
		if (!settings) await chrome.storage.local.set({ settings: { anthropicKey: a, model: "claude-sonnet-5-5", allowChanges: false, confirmRisky: true, keepDays: 90 } });
	}, ANTHROPIC_API_KEY);
	const page = ctx.pages()[0] || (await ctx.newPage());
	await page.goto(`${origin}/app`, { waitUntil: "load" });
	if (page.url().includes("/login")) {
		await page.fill("#login_email", ERP_USER);
		await page.fill("#login_password", ERP_PASS);
		await page.press("#login_password", "Enter");
		await page.waitForURL(/\/(app|desk)/, { timeout: 30000 });
	}
	await page.waitForSelector("#t-bar input", { state: "visible", timeout: 20000 });
	return { ctx, page, sw };
}

// Send a message and wait for its cost line; answer approval cards with `onCard` if given.
async function ask(page, text, onCard) {
	const before = await page.$$eval(".tcost", (e) => e.length);
	await page.fill("#t-bar input", text);
	await page.press("#t-bar input", "Enter");
	const t0 = Date.now();
	let card = null;
	while (Date.now() - t0 < 240000) {
		try {
			const pending = page.locator(".tapprove.pending:visible").first();
			if (onCard && !card && (await pending.count())) {
				card = { title: await pending.locator(".qt").innerText(), body: await pending.locator(".qd").innerText() };
				await onCard(pending, card);
			}
			if ((await page.$$eval(".tcost", (e) => e.length)) > before) break;
		} catch {} // the agent navigated mid-check; look again
		await page.waitForTimeout(800);
	}
	const last = await page.$$eval(".tcost", (els) => {
		const e = els[els.length - 1];
		return { text: e?.textContent, calls: (e?.dataset.calls || "").split(",").filter(Boolean).map(Number) };
	});
	const answer = await page.$$eval(".tmsg.assistant", (els) => els[els.length - 1]?.textContent || "");
	return { ...last, answer, card };
}

// Start a new conversation the way a user would: open the thread card, press New, close it.
async function newConversation(page) {
	await page.click('#t-bar [data-a="drawer"]');
	await page.click("#t-new");
	await page.keyboard.press("Escape");
	await page.waitForTimeout(500);
}

const skills = (sw) => sw.evaluate(() => chrome.storage.local.get("skills").then((x) => x.skills || []));

try {
	// ---------- 1. Persistence across a browser restart ----------
	let { ctx, page } = await launch();
	const first = await ask(page, "How many suppliers do we have? Just the number and their names.");
	await page.waitForTimeout(4000); // let the title come back
	const title = await page.$eval("#t-title", (e) => e.textContent);
	await ctx.close();

	({ ctx, page } = await launch());
	await page.waitForTimeout(1500);
	const restored = await page.$$eval(".tmsg.assistant", (els) => els.map((e) => e.textContent).join(" "));
	check("transcript restored after browser restart", /supplier/i.test(restored), `title "${title}"`);
	const recall = await ask(page, "What did I ask you before this, and what was the answer? Answer from memory; don't look anything up.");
	const supplierCount = (first.answer.match(/\b(\d+)\s+suppliers?\b/i) || [])[1];
	check(
		"answers from the restored conversation without tools",
		recall.calls.length === 1 && /supplier/i.test(recall.answer) && (!supplierCount || recall.answer.includes(supplierCount)),
		`${recall.calls.length} API call(s); "${recall.answer.slice(0, 120).replace(/\n/g, " ")}"`
	);

	// ---------- 2. Storage: 100 conversations ----------
	const sw = ctx.serviceWorkers()[0];
	await sw.evaluate(async (site) => {
		const db = await new Promise((res, rej) => {
			const r = indexedDB.open("showme");
			r.onsuccess = () => res(r.result);
			r.onerror = () => rej(r.error);
		});
		const t = db.transaction(["conversations", "transcripts"], "readwrite");
		const ui = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "Lorem ipsum dolor sit amet ".repeat(30) }));
		const api = ui.map((m) => ({ role: m.role, content: m.text }));
		for (let i = 0; i < 100; i++) {
			const id = `synthetic-${i}`;
			t.objectStore("conversations").put({ id, site, title: `Synthetic ${i}`, titleSource: "user", createdAt: Date.now() - i * 6e4, updatedAt: Date.now() - i * 6e4 - 1e7, pinned: false, usd: 0.01, tokens: 1000 });
			t.objectStore("transcripts").put({ id, ui, api, frozen: { model: "x", system: "s".repeat(8000), tools: [] } });
		}
		await new Promise((r) => (t.oncomplete = r));
	}, origin);
	const t0 = Date.now();
	await page.click('#t-bar [data-a="history"]');
	await page.waitForFunction(() => document.querySelectorAll("#t-hist .it").length >= 100, null, { timeout: 10000 });
	const ms = Date.now() - t0;
	const est = await sw.evaluate(() => navigator.storage.estimate());
	check("History lists 100+ conversations in under 500 ms", ms < 500, `${ms} ms`);
	check("100 conversations stay well under quota", est.usage < est.quota * 0.01, `${(est.usage / 1e6).toFixed(1)} MB of ${(est.quota / 1e9).toFixed(0)} GB`);
	await page.click('#t-bar [data-a="history"]');
	await sw.evaluate(async () => {
		const db = await new Promise((res) => (indexedDB.open("showme").onsuccess = (e) => res(e.target.result)));
		const t = db.transaction(["conversations", "transcripts"], "readwrite");
		for (let i = 0; i < 100; i++) {
			t.objectStore("conversations").delete(`synthetic-${i}`);
			t.objectStore("transcripts").delete(`synthetic-${i}`);
		}
		await new Promise((r) => (t.oncomplete = r));
	});

	// ---------- 3. Setup memory ----------
	const notes = async () => (await skills(sw)).find((s) => s.name === "site-notes" && s.scope === origin)?.content || "";
	const before = await notes();
	await newConversation(page);
	await page.waitForTimeout(500);
	const declined = await ask(page, "By the way, here we call customers 'parties'. How many parties do we have?", async (card) => {
		await card.locator(".lnk").click(); // Cancel (a real click)
	});
	check("declined memory card saves nothing", (await notes()) === before, declined.card ? `card: "${declined.card.body.split("\n")[0]}"` : "no card was proposed");

	await newConversation(page);
	await page.waitForTimeout(500);
	const approved = await ask(page, "Note for the future: in our company 'indent' means a Material Request of type Purchase. How many indents do we have?", async (card) => {
		await card.locator(".btn").click(); // Remember (a real click)
	});
	const after = await notes();
	const fact = approved.card?.body.split("\n")[0].trim();
	check("a card was proposed for a stated fact", Boolean(approved.card), approved.card ? `"${approved.card.title}"` : "none");
	check("approved fact saved exactly as shown", Boolean(fact) && after.includes(fact) && after !== before, fact ? `"${fact}"` : "");
	// ---------- 4. Page scripts can't press ShowMe's buttons ----------
	await newConversation(page);
	await page.waitForTimeout(500);
	await page.fill("#t-bar input", "Open the most recent draft Material Request and click Submit on it.");
	await page.press("#t-bar input", "Enter");
	const card = await page.waitForSelector("#t-bar .tapprove.pending .btn", { timeout: 240000 }).catch(() => null);
	if (!card) check("approval card appears for Submit", false, "no card");
	else {
		await page.evaluate(() => document.querySelector("#t-bar .tapprove.pending .btn").click()); // synthetic, as a page script would
		await page.waitForTimeout(3000);
		check("a page script's click on Allow is ignored", Boolean(await page.$("#t-bar .tapprove.pending")), "card still pending after untrusted click");
		await page.click("#t-bar .tapprove.pending .lnk"); // a real click on Cancel
		await page.waitForFunction(() => !document.querySelector(".tapprove.pending"), null, { timeout: 15000 }).catch(() => {});
		check("a real click on Cancel works", !(await page.$(".tapprove.pending")), "");
		await page.waitForSelector(".tcost", { timeout: 120000 }).catch(() => {});
	}
	await ctx.close();
} catch (e) {
	check("test run", false, e.message);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
