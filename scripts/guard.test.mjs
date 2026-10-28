// run_js write guard: model-written code may read anything but must not be able to save, submit, cancel or
// delete. Runs the exact function the extension injects (taken from background.js) in a logged-in ERPNext page,
// then checks the database didn't change. No API key needed.
//   ERP_URL=http://localhost:8080 node scripts/guard.test.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const { ERP_URL, ERP_USER = "Administrator", ERP_PASS = "admin" } = process.env;
if (!ERP_URL) {
	console.error("Set ERP_URL (and ERP_USER / ERP_PASS).");
	process.exit(2);
}
const origin = new URL(ERP_URL).origin;

// The injected function: the `async (c) => { … }` passed to inPage() in runJs.
const bg = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const start = bg.indexOf("async (c) => {", bg.indexOf("const runJs ="));
const end = bg.indexOf("\t\t[code]", start);
const fnSrc = bg.slice(start, end).trim().replace(/,$/, "");

const results = [];
const check = (name, pass, detail) => {
	results.push(pass);
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	await page.goto(`${origin}/login`);
	await page.fill("#login_email", ERP_USER);
	await page.fill("#login_password", ERP_PASS);
	await page.press("#login_password", "Enter");
	await page.waitForURL(/\/(app|desk)/, { timeout: 30000 });
	await page.waitForFunction(() => window.frappe?.call && window.frappe?.csrf_token);

	const run = (code) => page.evaluate(([src, c]) => (0, eval)(`(${src})`)(c), [fnSrc, code]);
	const name = await page.evaluate(async () => (await frappe.db.get_list("Customer", { fields: ["name"], limit: 1 }))[0].name);
	const before = await page.evaluate(async (n) => (await frappe.db.get_value("Customer", n, "customer_details")).message.customer_details, name);

	let r = await run(`return (await frappe.call("frappe.client.get_count", { doctype: "Customer" })).message`);
	check("reads still work (frappe.call)", r.ok && Number(r.v) > 0, r.v);
	r = await run(`return (await frappe.db.get_list("Customer", { fields: ["name"], limit: 2 })).length`);
	check("reads still work (frappe.db)", r.ok && Number(r.v) > 0, r.v);

	r = await run(`return await frappe.call("frappe.client.set_value", { doctype: "Customer", name: ${JSON.stringify(name)}, fieldname: "customer_details", value: "GUARD TEST" })`);
	check("frappe.client.set_value is blocked", !r.ok && /blocked/.test(r.v), r.v.slice(0, 90));

	r = await run(`return await fetch("/api/resource/Customer", { method: "POST", headers: { "Content-Type": "application/json", "X-Frappe-CSRF-Token": frappe.csrf_token }, body: JSON.stringify({ customer_name: "Guard Test Customer" }) }).then((x) => x.status)`);
	check("REST insert (POST /api/resource) is blocked", !r.ok && /blocked/.test(r.v), r.v.slice(0, 90));

	r = await run(`frappe.set_route("Form", "Customer", ${JSON.stringify(name)}); await new Promise((r) => setTimeout(r, 2500)); cur_frm.doc.customer_details = "GUARD TEST"; cur_frm.dirty(); await cur_frm.save(); return "saved"`);
	check("cur_frm.save() is blocked", !r.ok && /blocked/.test(r.v), r.v.slice(0, 90));

	r = await run(`return await frappe.call("frappe.client.submit", { doc: { doctype: "Customer", name: ${JSON.stringify(name)} } })`);
	check("frappe.client.submit is blocked", !r.ok && /blocked/.test(r.v), r.v.slice(0, 90));

	r = await run(`return await frappe.call("frappe.client.delete", { doctype: "Customer", name: "Guard Test Customer" })`);
	check("frappe.client.delete is blocked", !r.ok && /blocked/.test(r.v), r.v.slice(0, 90));

	const after = await page.evaluate(async (n) => (await frappe.db.get_value("Customer", n, "customer_details")).message.customer_details, name);
	const created = await page.evaluate(async () => (await frappe.db.get_list("Customer", { filters: { customer_name: "Guard Test Customer" } })).length);
	check("database unchanged", after === before && created === 0, `customer_details ${JSON.stringify(after)}, test customers ${created}`);
	const restored = await page.evaluate(() => !/ShowMe/.test(String(window.fetch)) && !/__showme/.test(String(XMLHttpRequest.prototype.open)));
	check("page's fetch and XHR restored afterwards", restored);
} catch (e) {
	check("test run", false, e.message);
} finally {
	await browser.close();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
