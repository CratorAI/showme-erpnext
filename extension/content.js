// ShowMe for ERPNext: content script (runs in the page, in the extension's isolated world).
//  1. The sidebar: chat, steps, approval cards, voice.
//  2. The agent's eyes: snapshot() lists what's on screen as ref-tagged lines ("e12 textbox …").
//  3. The agent's hands: an animated cursor, then real-looking pointer/mouse/keyboard events.
// The agent itself runs in the extension's service worker (background.js).
(() => {
	if (window.__trainer) return;
	// Only on the Frappe desk (not the login page or the public website).
	const isDesk = () => /^\/(app|desk)(\/|$)/.test(location.pathname);

	const bg = (msg) => chrome.runtime.sendMessage(msg).catch(() => ({}));
	const emit = (evt) => {
		if (evt.type === "chat") bg({ kind: "chat", text: evt.text, voice: evt.voice });
		else if (evt.type === "approve" || evt.type === "reject") bg({ kind: evt.type, id: evt.id });
	};
	let hasKey = true;
	let nextRef = 1;

	// ---------- 1. Snapshot ----------

	const INTERACTIVE = [
		"a[href]", "button", "input:not([type=hidden])", "select", "textarea",
		"[role=button]", "[role=tab]", "[role=menuitem]", "[role=link]", "[role=option]",
		"[contenteditable=true]", ".awesomplete li",
	].join(",");

	const visible = (el) => {
		const r = el.getBoundingClientRect();
		if (r.width < 2 || r.height < 2) return false;
		const s = getComputedStyle(el);
		return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
	};
	const clean = (t, n = 70) => (t || "").replace(/\s+/g, " ").trim().slice(0, n);

	function roleOf(el) {
		const r = el.getAttribute("role");
		if (r) return r;
		const tag = el.tagName.toLowerCase();
		if (tag === "a") return "link";
		if (tag === "select") return "combobox";
		if (tag === "textarea") return "textbox";
		if (tag === "input") {
			const t = el.type;
			if (t === "checkbox" || t === "radio") return t;
			if (t === "button" || t === "submit") return "button";
			return "textbox";
		}
		if (el.closest(".awesomplete")) return "option";
		return tag === "button" ? "button" : "editable";
	}

	function nameOf(el) {
		const field = el.closest("[data-fieldname]");
		const label = field && field.querySelector(".control-label, label");
		return clean(
			el.getAttribute("aria-label") ||
				(label && label.textContent) ||
				el.getAttribute("data-label") ||
				el.innerText ||
				el.getAttribute("placeholder") ||
				el.getAttribute("title") ||
				el.value
		);
	}

	function snapshot(max = 150) {
		const out = [];
		const route = window.frappe && frappe.get_route ? frappe.get_route().join("/") : "";
		out.push(`url: ${location.pathname}${location.search}  route: ${route}`);
		const title = document.querySelector(".page-head:not([style*='none']) .title-text, .page-title .title-text, h1");
		if (title && visible(title)) out.push(`page: ${clean(title.innerText)}`);
		const modal = [...document.querySelectorAll(".modal.show .modal-title")].pop();
		if (modal) out.push(`dialog: ${clean(modal.innerText)}`);
		const msg = [...document.querySelectorAll(".msgprint, .alert-message, .desk-alert .alert-message")]
			.filter(visible).map((m) => clean(m.innerText, 160));
		if (msg.length) out.push(`message: ${msg.join(" | ")}`);
		out.push("---");

		const root = document.querySelector(".modal.show") || document;
		let n = 0;
		for (const el of root.querySelectorAll(INTERACTIVE)) {
			if (el.closest("#trainer-root") || !visible(el)) continue;
			if (!el.dataset.tref) el.dataset.tref = `e${nextRef++}`;
			const role = roleOf(el);
			const fieldname = el.closest("[data-fieldname]")?.dataset.fieldname;
			let line = `${el.dataset.tref} ${role} "${nameOf(el)}"`;
			if (fieldname) line += ` [${fieldname}]`;
			if (role === "checkbox" || role === "radio") line += el.checked ? " checked" : " unchecked";
			else if ("value" in el && el.value && role !== "button") line += ` = "${clean(el.value, 50)}"`;
			if (el.getAttribute("aria-selected") === "true" || el.classList.contains("active")) line += " selected";
			if (el.disabled || el.readOnly) line += " disabled";
			out.push(line);
			if (++n >= max) {
				out.push(`… (truncated at ${max}; call snapshot with a larger max)`);
				break;
			}
		}
		return out.join("\n");
	}

	// ---------- 2. Visual trainer ----------

	const PANEL_W = 380;
	// Width the page has left once the sidebar is open; cards stay out from under it.
	const viewW = () => innerWidth - (document.documentElement.classList.contains("trainer-open") ? PANEL_W : 0);

	const CRATOR_ICON = `<svg viewBox="0 0 25 25" fill="currentColor"><path d="M19.0342 20.2256C19.0342 21.6609 17.8708 22.8249 16.4355 22.8252H8.50781C7.07231 22.8252 5.9082 21.6611 5.9082 20.2256V18.8896H19.0342V20.2256ZM5.9082 18.8896H4.42285C2.98745 18.8896 1.82427 17.7264 1.82422 16.291V8.36328C1.82422 6.92783 2.98742 5.76375 4.42285 5.76367H5.9082V18.8896ZM20.2256 5.76367C21.6611 5.76367 22.8252 6.92778 22.8252 8.36328V16.291C22.8251 17.7265 21.6611 18.8896 20.2256 18.8896H19.0342V5.76367H20.2256ZM16.4355 1.82324C17.8708 1.82349 19.0341 2.98657 19.0342 4.42188V5.76367H5.9082V4.42188C5.90825 2.98641 7.07234 1.82324 8.50781 1.82324H16.4355Z"/></svg>`;
	const ICON = {
		x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
		up: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
		chevR: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`,
		chevD: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
		dot: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="3.5"/></svg>`,
		mic: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/></svg>`,
		speaker: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>`,
		speakerOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6M16 9l6 6"/></svg>`,
		plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
		gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
		history: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>`,
		pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 10.8V4h6v6.8l3 3.2H6z"/></svg>`,
		stop: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`,
		check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
	};

	// Crator design tokens (crator-frontend app/globals.css, light theme).
	const css = `
	#trainer-root{--bg:#fcfcfb;--fg:oklch(0.145 0 0);--card:#fff;--muted:oklch(0.97 0 0);--muted-fg:oklch(0.556 0 0);
		--border:oklch(0.922 0 0);--user:#f2f2f2;--brand:#f9693c;--brand-fg:oklch(0.985 0 0);--success:oklch(0.55 0.15 160);
		--success-muted:oklch(0.97 0.03 165);--warning:oklch(0.78 0.15 85);--warning-muted:oklch(0.97 0.04 90);--destructive:oklch(0.577 0.245 27.325);
		--shimmer:oklch(0.6 0.015 70);--shimmer-hi:oklch(0.86 0.01 80);
		position:fixed;inset:0;pointer-events:none;z-index:2147483000;
		font:14px/1.5 "Mona Sans",ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--fg);-webkit-font-smoothing:antialiased}
	#trainer-root *{box-sizing:border-box}
	#trainer-root svg{display:block}
	#trainer-spot{position:fixed;border-radius:10px;box-shadow:0 0 0 3px var(--brand),0 0 0 9999px rgba(15,15,15,.38);transition:all .35s cubic-bezier(.23,1,.32,1);display:none}
	#trainer-spot.turn{box-shadow:0 0 0 3px var(--success),0 0 0 9999px rgba(15,15,15,.3);animation:tpulse 1.4s infinite}
	@keyframes tpulse{50%{box-shadow:0 0 0 7px color-mix(in oklab,var(--success) 45%,transparent),0 0 0 9999px rgba(15,15,15,.3)}}
	#trainer-card{position:fixed;width:340px;background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.18);padding:16px;pointer-events:auto;transition:top .35s,left .35s;display:none}
	#trainer-card .step{font-size:12px;color:var(--muted-fg);margin-bottom:2px}
	#trainer-card .title{font-weight:600;font-size:14px;margin-bottom:4px}
	#trainer-card .body{color:var(--muted-fg);white-space:pre-wrap}
	#trainer-card .body b{color:var(--fg);font-weight:600}
	#trainer-card .turnhint{margin-top:8px;color:var(--success);font-weight:500;font-size:13px}
	#trainer-card .trow{display:flex;gap:8px;margin-top:12px;align-items:center;justify-content:flex-end}
	#trainer-card button{border:0;border-radius:8px;height:32px;padding:0 12px;font:inherit;font-size:13px;cursor:pointer;background:transparent;color:var(--muted-fg)}
	#trainer-card button.primary{background:var(--brand);color:var(--brand-fg)}
	#trainer-card .thinking{font-size:12px;color:var(--muted-fg);margin-top:8px;display:none}

	html.trainer-anim body{transition:margin-right .32s cubic-bezier(.23,1,.32,1)}
	html.trainer-anim .navbar{transition:right .32s cubic-bezier(.23,1,.32,1)}
	html.trainer-open body{margin-right:${PANEL_W}px !important}
	html.trainer-open .navbar, html.trainer-open header.navbar{right:${PANEL_W}px !important}
	#trainer-panel{position:fixed;top:0;right:0;bottom:0;width:${PANEL_W}px;background:var(--bg);border-left:1px solid var(--border);display:flex;flex-direction:column;pointer-events:auto;z-index:3}
	#trainer-panel{transition:transform .34s cubic-bezier(.23,1,.32,1),box-shadow .34s,visibility 0s}
	#trainer-panel.closed{transform:translateX(100%);visibility:hidden;transition:transform .24s cubic-bezier(.4,0,1,1),visibility 0s .24s}
	#trainer-panel.noanim,#trainer-launch.noanim{transition:none!important}
	#trainer-panel header{height:56px;padding:0 12px 0 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0}
	#trainer-panel header .logo{width:22px;height:22px;color:var(--fg)}
	#trainer-panel header .t{font-weight:600;font-size:15px;letter-spacing:-.01em}
	#trainer-panel header .s{font-size:12px;color:var(--muted-fg);margin-left:2px;white-space:nowrap}
	.ticonbtn+.ticonbtn{margin-left:0!important}
	#t-voice.on{color:var(--brand);background:color-mix(in oklab,var(--brand) 10%,transparent)}
	.ticonbtn{margin-left:auto;width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:var(--muted-fg);cursor:pointer;display:grid;place-items:center}
	.ticonbtn:hover{background:var(--muted);color:var(--fg)}
	.ticonbtn svg{width:16px;height:16px}

	#trainer-panel header .hd{min-width:0;display:flex;flex-direction:column;line-height:1.2}
	#trainer-panel header .hd .s{margin-left:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
	#t-history.on{color:var(--fg);background:var(--muted)}
	#t-hist{flex:1;overflow-y:auto;padding:12px 8px}
	#t-hist .hh{display:flex;align-items:center;justify-content:space-between;padding:4px 8px 10px}
	#t-hist .hh b{font-weight:600;font-size:14px}
	#t-hist .priv{font-size:12px;color:var(--muted-fg);padding:0 8px 10px}
	#t-hist .it{display:flex;align-items:center;gap:8px;padding:8px;border-radius:10px;cursor:pointer}
	#t-hist .it:hover{background:var(--muted)}
	#t-hist .it.cur{background:var(--muted)}
	#t-hist .it .tx{flex:1;min-width:0}
	#t-hist .it .tt{font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
	#t-hist .it .mt{font-size:12px;color:var(--muted-fg)}
	#t-hist .it .ac{display:none;gap:2px}
	#t-hist .it:hover .ac{display:flex}
	#t-hist .it .ac button{all:unset;cursor:pointer;font-size:12px;color:var(--muted-fg);padding:2px 5px;border-radius:6px}
	#t-hist .it .ac button:hover{color:var(--fg);background:var(--card)}
	#t-hist .pinned svg{width:12px;height:12px;color:var(--muted-fg)}
	#t-hist .empty{color:var(--muted-fg);font-size:13px;padding:8px}
	.tnote{font-size:12px;color:var(--muted-fg);font-style:italic;text-align:center;padding:0 12px}
	.tmsg.user.queued{opacity:.55}
	.tapprove .qx{margin-top:8px;font-size:12px;color:var(--muted-fg)}
	#trainer-msgs{flex:1;overflow-y:auto;padding:20px 16px 8px;display:flex;flex-direction:column;gap:16px}
	.tmsg{font-size:14px;line-height:1.625;word-wrap:break-word}
	.tmsg.user{align-self:flex-end;max-width:85%;white-space:pre-wrap;background:var(--user);border-radius:10px;padding:12px}
	.tmsg.assistant{white-space:normal}
	.tmsg.assistant p{margin:0 0 10px}.tmsg.assistant>:last-child{margin-bottom:0}
	.tmsg.assistant ul,.tmsg.assistant ol{margin:0 0 10px;padding-left:20px}.tmsg.assistant li{margin:2px 0}
	.tmsg.assistant h1,.tmsg.assistant h2,.tmsg.assistant h3,.tmsg.assistant h4{all:unset;display:block;font-weight:600;margin:14px 0 6px;letter-spacing:-.01em}
	.tmsg.assistant h1,.tmsg.assistant h2{font-size:16px}.tmsg.assistant h3,.tmsg.assistant h4{font-size:14.5px}
	.tmsg.assistant>h1:first-child,.tmsg.assistant>h2:first-child,.tmsg.assistant>h3:first-child{margin-top:0}
	.tmsg.assistant pre{margin:4px 0 12px;padding:10px 12px;border-radius:10px;background:var(--muted);overflow-x:auto;font:12.5px/1.5 "Geist Mono",ui-monospace,monospace;white-space:pre}
	.tmsg.assistant a{color:var(--fg);text-decoration:underline;text-underline-offset:3px}
	.tmsg.assistant hr{border:0;border-top:1px solid var(--border);margin:12px 0}
	.tmsg.assistant table{width:100%;border-collapse:collapse;margin:4px 0 12px;font-size:13px}
	.tmsg.assistant th{text-align:left;font-weight:500;color:var(--muted-fg);border-bottom:1px solid var(--border);padding:6px 8px 6px 0}
	.tmsg.assistant td{border-bottom:1px solid var(--border);padding:6px 8px 6px 0;vertical-align:top}
	.tmsg.assistant b{font-weight:600}
	.tmsg.assistant code{font-family:"Geist Mono",ui-monospace,monospace;font-size:12.5px;background:var(--muted);padding:1px 5px;border-radius:5px}

	.tcost{font-size:12px;color:var(--muted-fg);opacity:.75;margin-top:-8px;font-variant-numeric:tabular-nums}
	.tgroup{font-size:14px}
	.tgroup .gh{all:unset;display:flex;align-items:center;gap:4px;color:var(--muted-fg);cursor:pointer;max-width:100%}
	.tgroup .gh:hover{color:var(--fg)}
	.tgroup .gh span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
	.tgroup .gh svg{width:12px;height:12px;flex-shrink:0}
	.tgroup .gn{color:var(--muted-fg);opacity:.7}
	.tgroup .gb{position:relative;margin:8px 0 0 4px;display:flex;flex-direction:column;gap:12px}
	.tgroup .gb:before{content:"";position:absolute;left:7px;top:4px;bottom:4px;width:1px;background:var(--border)}
	.tgroup .gi{position:relative;padding-left:24px;color:var(--muted-fg);font-size:13.5px}
	.tgroup .gi i{font-style:normal;position:absolute;left:0;top:2px;width:16px;height:18px;display:grid;place-items:center;background:var(--bg);color:var(--muted-fg)}
	.tgroup .gi i svg{width:14px;height:14px}
	.cdx-shimmer{background-image:linear-gradient(90deg,var(--shimmer) 0%,var(--shimmer) 36%,var(--shimmer-hi) 50%,var(--shimmer) 64%,var(--shimmer) 100%);
		background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;animation:cdxsh 1.6s linear infinite}
	@keyframes cdxsh{0%{background-position:100% 50%}100%{background-position:0% 50%}}

	.tapprove{border:1px solid var(--border);border-radius:16px;background:var(--card);overflow:hidden}
	.tapprove .qh{padding:14px 16px 12px}
	.tapprove .qt{font-size:14px;font-weight:500}
	.tapprove .qd{margin-top:4px;font-size:14px;line-height:1.45;color:var(--muted-fg)}
	.tapprove .qd p{margin:0}
	.tapprove .ql{margin:12px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
	.tapprove .ql li{display:flex;gap:8px;align-items:baseline;font-size:13px}
	.tapprove .tag{flex-shrink:0;font-family:"Geist Mono",ui-monospace,monospace;font-size:11px;padding:1px 6px;border-radius:5px;background:var(--muted);color:var(--muted-fg)}
	.tapprove .qf{border-top:1px solid var(--border);padding:8px 12px 8px 16px;display:flex;align-items:center;justify-content:flex-end;gap:4px;min-height:48px}
	.tapprove .qs{margin-right:auto;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted-fg)}
	.tapprove .qs svg{width:14px;height:14px}
	.tapprove.applied .qs,.tapprove.approved .qs{color:var(--success)}
	.tapprove.failed .qs{color:var(--destructive)}
	.tapprove .lnk{all:unset;cursor:pointer;font-size:13px;color:var(--muted-fg);padding:0 8px}
	.tapprove .lnk:hover{color:var(--fg);text-decoration:underline;text-underline-offset:4px}
	.tapprove .btn{all:unset;cursor:pointer;height:32px;min-width:64px;padding:0 14px;border-radius:8px;background:var(--brand);color:var(--brand-fg);font-size:13px;font-weight:500;text-align:center;line-height:32px}
	.tapprove .btn:hover{background:color-mix(in oklab,var(--brand) 85%,white)}

	.tempty{margin:auto 0;padding:0 4px}
	.tempty h3{all:unset;display:block;font-size:20px;font-weight:600;letter-spacing:-.015em}
	.tempty p{margin:6px 0 16px;color:var(--muted-fg);font-size:14px;line-height:1.5}
	.tempty .sugg{display:block;width:100%;text-align:left;margin-top:8px;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:var(--card);cursor:pointer;font:inherit;font-size:13.5px;color:var(--fg)}
	.tempty .sugg:hover{background:var(--muted)}

	#trainer-panel form{flex-shrink:0;padding:8px 12px 12px}
	#trainer-panel .composer{display:flex;flex-direction:column;min-height:104px;border:1px solid var(--border);border-radius:16px;background:var(--card);box-shadow:0 4px 6px -1px rgba(0,0,0,.06),0 2px 4px -2px rgba(0,0,0,.06);transition:border-color .15s}
	#trainer-panel .composer:focus-within{border-color:color-mix(in oklab,var(--fg) 20%,transparent)}
	#trainer-panel textarea{flex:1;resize:none;border:0;outline:none;background:transparent;font:inherit;font-size:14px;padding:12px 16px 0;min-height:48px;max-height:160px;color:var(--fg)}
	#trainer-panel textarea::placeholder{color:var(--muted-fg)}
	#trainer-panel .cbar{display:flex;align-items:center;justify-content:space-between;padding:4px 10px 10px 16px}
	#trainer-panel .cbar .hint{font-size:12px;color:var(--muted-fg)}
	#trainer-panel .cbtns{display:flex;gap:6px;align-items:center}
	#trainer-panel .mic{all:unset;position:relative;cursor:pointer;width:32px;height:32px;border-radius:8px;color:var(--muted-fg);display:grid;place-items:center;transition:background .15s,color .15s}
	#trainer-panel .mic:hover{background:var(--muted);color:var(--fg)}
	#trainer-panel .mic svg{width:17px;height:17px;position:relative;z-index:1}
	#trainer-panel .mic.on{color:#fff;background:var(--brand)}
	#trainer-panel .mic .ring{position:absolute;inset:0;border-radius:8px;pointer-events:none}
	#trainer-panel .mic.on .ring{animation:tring 1.3s ease-out infinite}
	@keyframes tring{0%{box-shadow:0 0 0 0 color-mix(in oklab,var(--brand) 50%,transparent)}100%{box-shadow:0 0 0 10px transparent}}
	#trainer-panel .cbar .hint .cap{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:230px;color:var(--fg)}
	#trainer-panel .cbar .hint.live{color:var(--brand);cursor:pointer;display:flex;align-items:center;gap:8px}
	.twave{display:inline-flex;gap:2px;align-items:center;height:14px}
	.twave i{width:2.5px;border-radius:2px;background:currentColor;animation:twave .9s ease-in-out infinite}
	.twave i:nth-child(1){height:5px;animation-delay:0s}.twave i:nth-child(2){height:12px;animation-delay:.12s}.twave i:nth-child(3){height:8px;animation-delay:.24s}.twave i:nth-child(4){height:13px;animation-delay:.36s}.twave i:nth-child(5){height:6px;animation-delay:.48s}
	@keyframes twave{0%,100%{transform:scaleY(.4)}50%{transform:scaleY(1)}}
	#trainer-panel .send{all:unset;cursor:pointer;width:32px;height:32px;border-radius:8px;background:var(--brand);color:var(--brand-fg);display:grid;place-items:center}
	#trainer-panel .send:hover{background:color-mix(in oklab,var(--brand) 85%,white)}
	#trainer-panel .send svg{width:16px;height:16px}
	#trainer-panel .send{transition:transform .15s,background .15s}
	#trainer-panel .send:active{transform:scale(.88)}
	#trainer-panel .send.fly svg{animation:tfly .45s cubic-bezier(.23,1,.32,1)}
	@keyframes tfly{0%{transform:none}45%{transform:translateY(-14px);opacity:0}46%{transform:translateY(12px);opacity:0}100%{transform:none;opacity:1}}

	/* Entrance animations: only elements that are new to the transcript get .anim-in */
	.anim-in{animation:tin .34s cubic-bezier(.23,1,.32,1) both}
	@keyframes tin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
	.tmsg.user.anim-in{transform-origin:100% 100%;animation:tuser .32s cubic-bezier(.23,1,.32,1) both}
	@keyframes tuser{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:none}}
	.tapprove.anim-in{transform-origin:50% 100%;animation:tpop .42s cubic-bezier(.34,1.4,.64,1) both}
	@keyframes tpop{from{opacity:0;transform:translateY(10px) scale(.96)}to{opacity:1;transform:none}}
	.tapprove .qs.anim-in{animation:tin .3s ease both}
	.tgroup .gb{animation:tin .26s cubic-bezier(.23,1,.32,1) both}
	.tgroup .gh svg{transition:transform .2s}
	.tempty>*{animation:tin .45s cubic-bezier(.23,1,.32,1) both}
	.tempty>*:nth-child(2){animation-delay:.05s}.tempty>*:nth-child(3){animation-delay:.1s}.tempty>*:nth-child(4){animation-delay:.15s}
	.tempty>*:nth-child(5){animation-delay:.2s}.tempty>*:nth-child(6){animation-delay:.25s}
	.tempty .sugg{transition:background .15s,transform .15s,border-color .15s}
	.tempty .sugg:hover{transform:translateX(2px);border-color:color-mix(in oklab,var(--fg) 15%,transparent)}
	.tdots{display:inline-flex;gap:4px;align-items:center;height:20px}
	.tdots i{width:6px;height:6px;border-radius:50%;background:var(--shimmer);animation:tdot 1.2s infinite ease-in-out both}
	.tdots i:nth-child(2){animation-delay:.15s}.tdots i:nth-child(3){animation-delay:.3s}
	@keyframes tdot{0%,80%,100%{opacity:.3;transform:scale(.8)}40%{opacity:1;transform:none}}
	@media (prefers-reduced-motion: reduce){#trainer-root *,#trainer-root *:before{animation:none!important;transition:none!important}}

	#trainer-launch{position:fixed;right:20px;bottom:20px;width:44px;height:44px;border-radius:12px;border:1px solid var(--border);background:var(--card);color:var(--fg);box-shadow:0 4px 14px rgba(0,0,0,.1);cursor:pointer;pointer-events:none;display:grid;place-items:center;
		opacity:0;transform:scale(.6) translateY(8px);transition:opacity .2s,transform .3s cubic-bezier(.34,1.56,.64,1)}
	#trainer-launch.show{opacity:1;transform:none;pointer-events:auto;transition-delay:.12s}
	#trainer-launch:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,.14)}
	#trainer-launch:active{transform:scale(.94)}
	#trainer-launch svg{width:22px;height:22px}
	#trainer-root #trainer-cursor{position:fixed;width:22px;height:22px;margin:-4px 0 0 -4px;display:none;transition:left .7s cubic-bezier(.4,0,.2,1),top .7s cubic-bezier(.4,0,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
	#trainer-ripple{position:fixed;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid var(--brand);opacity:0;pointer-events:none}
	#trainer-ripple.go{animation:tripple .5s ease-out}
	@keyframes tripple{from{opacity:1;transform:scale(.3)}to{opacity:0;transform:scale(1.4)}}`;

	let root, spot, card, cursor, ripple, target = null, mode = "watch";

	function ensureUI() {
		if (root && document.body.contains(root)) return;
		const font = document.createElement("link");
		font.rel = "stylesheet";
		font.href = "https://fonts.googleapis.com/css2?family=Mona+Sans:wght@400..700&family=Geist+Mono&display=swap";
		document.head.appendChild(font);
		const style = document.createElement("style");
		style.textContent = css;
		document.head.appendChild(style);
		root = document.createElement("div");
		root.id = "trainer-root";
		root.innerHTML = `
			<div id="trainer-spot"></div>
			<div id="trainer-card">
				<div class="step"></div><div class="title"></div><div class="body"></div>
				<div class="turnhint"></div>
				<div class="trow actions"></div>
				<div class="thinking">Thinking…</div>
			</div>
			<aside id="trainer-panel">
				<header><div class="logo">${CRATOR_ICON}</div><div class="hd"><div class="t">ShowMe</div><div class="s" id="t-title">Your ERPNext guide</div></div>
					<button class="ticonbtn" id="t-history" title="History">${ICON.history}</button>
					<button class="ticonbtn" id="t-new" title="New conversation">${ICON.plus}</button>
					<button class="ticonbtn" id="t-settings" title="Settings and skills">${ICON.gear}</button>
					<button class="ticonbtn" id="t-voice" title="Voice (GPT-Live): talk to ShowMe">${ICON.speakerOff}</button>
					<button class="ticonbtn" id="t-close" title="Hide (⌘J)">${ICON.x}</button></header>
				<div id="trainer-msgs"></div>
				<div id="t-hist" hidden></div>
				<form><div class="composer"><textarea placeholder="Ask how to do something in your ERPNext…"></textarea>
					<div class="cbar"><span class="hint">⌘J to hide</span><div class="cbtns">
						<button type="button" class="mic" id="t-mic" title="Talk (or hold Space in voice mode)">${ICON.mic}<span class="ring"></span></button>
						<button class="send" title="Send">${ICON.up}</button></div></div></div></form>
			</aside>
			<button id="trainer-launch" title="ShowMe (⌘J)">${CRATOR_ICON}</button>
			<svg id="trainer-cursor" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="#f9693c" stroke="#fff" stroke-width="1.5"/></svg>
			<div id="trainer-ripple"></div>`;
		document.body.appendChild(root);
		spot = root.querySelector("#trainer-spot");
		card = root.querySelector("#trainer-card");
		cursor = root.querySelector("#trainer-cursor");
		ripple = root.querySelector("#trainer-ripple");
		panel = root.querySelector("#trainer-panel");
		msgs = root.querySelector("#trainer-msgs");
		const box = panel.querySelector("textarea");
		const send = () => {
			const text = box.value.trim();
			if (!text) return;
			box.value = "";
			const btn = panel.querySelector(".send");
			btn.classList.remove("fly");
			void btn.offsetWidth;
			btn.classList.add("fly");
			emit({ type: "chat", text, voice: voiceOn });
		};
		sendText = send;
		panel.querySelector("form").addEventListener("submit", (e) => {
			e.preventDefault();
			if (busy && !box.value.trim()) return bg({ kind: "stop" });
			send();
		});
		box.addEventListener("keydown", (e) => {
			e.stopPropagation(); // keep Frappe's keyboard shortcuts out of the composer
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				send();
			}
		});
		panel.querySelector("#t-close").onclick = () => setOpen(false);
		panel.querySelector("#t-settings").onclick = () => bg({ kind: "open-settings" });
		panel.querySelector("#t-new").onclick = () => {
			openGroups.clear();
			showHistory(false);
			bg({ kind: "new-chat" });
		};
		panel.querySelector("#t-history").onclick = () => showHistory(panel.querySelector("#t-hist").hidden);
		panel.querySelector("#t-voice").onclick = () => setVoice(!voiceOn);
		panel.querySelector("#t-mic").onclick = () => toggleMute();
		root.querySelector("#trainer-launch").onclick = () => setOpen(true);
		document.addEventListener("keydown", (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
				e.preventDefault();
				setOpen(panel.classList.contains("closed"));
			}
		});
		// First paint: no slide-in on every page load, only on user toggles.
		panel.classList.add("noanim");
		root.querySelector("#trainer-launch").classList.add("noanim");
		setOpen(sessionStorage.getItem("trainer-closed") !== "1");
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				panel.classList.remove("noanim");
				root.querySelector("#trainer-launch").classList.remove("noanim");
				document.documentElement.classList.add("trainer-anim");
			})
		);
		renderChat();
		updateHint();
		// Voice was on before this page load (e.g. a change reloaded the page): reconnect.
		if (voiceOn) setVoice(true);
		requestAnimationFrame(track);
	}

	// ---------- 3. Chat sidebar (Crator style) ----------
	// The daemon owns the transcript; the page just renders it (so it survives full reloads).

	let panel, msgs, transcript = [], busy = false;
	const openGroups = new Set();
	// Keys of transcript items already on screen. Re-renders (every streamed token) rebuild the DOM,
	// so only items whose key is new get the entrance animation. Reset per page load: no replay.
	const seen = new Set();
	let firstRender = true;
	const enter = (node, key) => {
		if (!seen.has(key)) {
			seen.add(key);
			if (!firstRender) node.classList.add("anim-in");
		}
		return node;
	};

	function setOpen(open) {
		panel.classList.toggle("closed", !open);
		root.querySelector("#trainer-launch").classList.toggle("show", !open);
		document.documentElement.classList.toggle("trainer-open", open);
		sessionStorage.setItem("trainer-closed", open ? "0" : "1");
		if (open) panel.querySelector("textarea").focus();
	}

	const SUGGESTIONS = [
		"Where do I see what customers owe us?",
		"Create a draft quotation for one of our customers",
		"How much stock do we have of our top item?",
		"I want to record a WhatsApp number on every customer",
	];

	const el = (html) => {
		const t = document.createElement("template");
		t.innerHTML = html.trim();
		return t.content.firstElementChild;
	};

	// Consecutive tool steps collapse into one group, like Crator's tool-activity-group:
	// the header names the latest step (shimmering while live) and expands into a timeline.
	function activityGroup(items, key, live) {
		const open = openGroups.has(key);
		const latest = items.at(-1).text;
		const g = el(`<div class="tgroup"><button class="gh">
			<span class="${live ? "cdx-shimmer" : ""}">${fmt(live ? latest : latest)}</span>
			${live ? "" : `<span class="gn">· ${items.length} step${items.length > 1 ? "s" : ""}</span>`}
			${open ? ICON.chevD : ICON.chevR}</button></div>`);
		g.querySelector(".gh").onclick = () => {
			open ? openGroups.delete(key) : openGroups.add(key);
			renderChat();
		};
		if (open) {
			const body = el(`<div class="gb"></div>`);
			for (const it of items) body.appendChild(el(`<div class="gi"><i>${ICON.dot}</i>${fmt(it.text)}</div>`));
			g.appendChild(body);
		}
		return g;
	}

	// A proposed setup change, styled like Crator's question form: what it does, the exact records,
	// then Cancel / Apply. Once applied it links to where the change lives.
	function approvalCard(m) {
		const what = (c) => {
			const v = c.values || {};
			const label = v.label || v.fieldname || v.property || v.name || v.workflow_name || v.subject || c.name || "";
			const on = v.dt || v.doc_type || v.reference_doctype || v.document_type || "";
			return `<li><span class="tag">${fmt(c.doctype)}</span><span>${fmt(label)}${on ? ` · ${fmt(on)}` : ""}</span></li>`;
		};
		const d = el(`<div class="tapprove ${m.status}"><div class="qh">
			<div class="qt">${fmt(m.title || "Apply this change to your ERPNext?")}</div>
			<div class="qd">${md(m.summary)}</div>
			${m.changes?.length ? `<ul class="ql">${m.changes.map(what).join("")}</ul>` : ""}
			${m.detail ? `<div class="qx">${fmt(m.detail)}</div>` : ""}</div>
			<div class="qf"></div></div>`);
		const foot = d.querySelector(".qf");
		if (m.status === "pending") {
			const cancel = el(`<button class="lnk">Cancel</button>`);
			cancel.onclick = () => emit({ type: "reject", id: m.id });
			const apply = el(`<button class="btn">${{ change: "Apply", memory: "Remember" }[m.kind] || "Allow"}</button>`);
			apply.onclick = () => emit({ type: "approve", id: m.id });
			foot.append(cancel, apply);
		} else {
			const label = { applying: "Applying…", applied: "Applied", approved: m.kind === "memory" ? "Saved to site notes" : "Allowed", cancelled: m.kind === "memory" ? "Not saved" : "Cancelled", failed: "Failed, nothing changed" }[m.status];
			const ok = m.status === "applied" || m.status === "approved";
			foot.appendChild(el(`<span class="qs">${ok ? ICON.check : ""}<span class="${m.status === "applying" ? "cdx-shimmer" : ""}">${label}</span></span>`));
			if (m.status === "applied") {
				const c = m.changes[0];
				const dt = c.values?.dt || c.values?.doc_type;
				const viaCustomize = ["Custom Field", "Property Setter"].includes(c.doctype) && dt;
				const link = el(`<button class="lnk">${viaCustomize ? "Open in Customize Form" : `Open ${fmt(c.doctype)}`}</button>`);
				link.onclick = () => {
					if (viaCustomize) bg({ kind: "open-customize", doctype: dt });
					else if (m.applied?.[0]) bg({ kind: "open-doc", doctype: m.applied[0].doctype, name: m.applied[0].name });
				};
				foot.appendChild(link);
			}
		}
		return d;
	}

	// ---------- 4. Voice: GPT-Live in front, the Claude agent behind ----------
	// GPT-Live (OpenAI, full duplex over WebRTC) does the talking: listening, interruptions, echo
	// cancellation. When the user asks for something in ERPNext it raises a *client delegation*; we
	// hand the request to the Claude agent (the hands) and stream its narration and final answer
	// back as `session.commentary.append`, which GPT-Live says aloud in its own words.

	let voiceOn = sessionStorage.getItem("trainer-voice") === "1";
	let live = null; // { pc, dc, stream, audio }
	let muted = false, speaking = false, connecting = false;
	let inputHeard = ""; // user transcript since the last delegation
	let activeDelegation = null;
	let caption = "";
	const sentUpTo = new Map(); // assistant message key -> chars already sent as commentary
	let voicePrimed = false; // set by the first transcript sync after a page load
	let lastApprovalVoiced = null;

	function setVoice(on) {
		voiceOn = on;
		sessionStorage.setItem("trainer-voice", on ? "1" : "0");
		const b = panel.querySelector("#t-voice");
		b.classList.toggle("on", on);
		b.innerHTML = on ? ICON.speaker : ICON.speakerOff;
		on ? startLive() : stopLive();
	}

	async function startLive() {
		if (live || connecting) return;
		connecting = true;
		updateHint();
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			const pc = new RTCPeerConnection();
			const audio = document.createElement("audio");
			audio.autoplay = true;
			root.appendChild(audio);
			pc.ontrack = (e) => (audio.srcObject = e.streams[0]);
			stream.getTracks().forEach((t) => pc.addTrack(t, stream));
			const dc = pc.createDataChannel("oai-events");
			dc.onmessage = (e) => onLiveEvent(JSON.parse(e.data));
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			await new Promise((r) => {
				if (pc.iceGatheringState === "complete") return r();
				pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && r();
				setTimeout(r, 1500);
			});
			// The background holds the OpenAI key and creates the session; the page only sees the SDP answer.
			const answer = await bg({ kind: "live-session", sdp: pc.localDescription.sdp, resume: sessionStorage.getItem("trainer-voice-resume") || "" });
			if (answer.error) throw new Error(answer.error);
			await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
			live = { pc, dc, stream, audio, startedAt: Date.now() };
			muted = false;
			pc.onconnectionstatechange = () => ["failed", "closed", "disconnected"].includes(pc.connectionState) && voiceOn && stopLive(true);
		} catch (err) {
			console.log("[live] failed", String(err));
			voiceOn = false;
			sessionStorage.setItem("trainer-voice", "0");
			panel.querySelector("#t-voice").classList.remove("on");
			panel.querySelector("#t-voice").innerHTML = ICON.speakerOff;
			caption = `Voice failed: ${err.message || err}`;
		}
		connecting = false;
		updateHint();
	}

	function stopLive(dropped) {
		if (live) {
			bg({ kind: "voice-usage", seconds: (Date.now() - live.startedAt) / 1000 });
			try {
				live.dc.readyState === "open" && live.dc.send(JSON.stringify({ type: "session.close" }));
			} catch {}
			live.stream.getTracks().forEach((t) => t.stop());
			live.pc.close();
			live.audio.remove();
		}
		live = null;
		speaking = false;
		caption = dropped ? "Voice disconnected" : "";
		updateHint();
	}

	function toggleMute() {
		if (!live) return setVoice(true);
		muted = !muted;
		live.stream.getAudioTracks().forEach((t) => (t.enabled = !muted));
		updateHint();
	}

	const send = (evt) => live && live.dc.readyState === "open" && live.dc.send(JSON.stringify(evt));
	const eid = () => `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
	const commentary = (content) =>
		activeDelegation && content.trim() &&
		send({ type: "session.commentary.append", event_id: eid(), delegation_id: activeDelegation, content: content.slice(0, 1800) });
	const liveThinking = (content) =>
		activeDelegation && send({ type: "session.thinking.append", event_id: eid(), delegation_id: activeDelegation, content });

	function onLiveEvent(ev) {
		const t = ev.type || "";
		if (!/delta$/.test(t)) console.log("[live]", t, JSON.stringify(ev).slice(0, 300));
		if (t === "session.input_transcript.delta") {
			inputHeard += ev.delta || "";
			panel.querySelector("textarea").value = inputHeard.trim();
		} else if (t === "session.output_transcript.delta") {
			speaking = true;
			caption = (caption + (ev.delta || "")).slice(-140);
			updateHint();
			clearTimeout(onLiveEvent.quiet);
			onLiveEvent.quiet = setTimeout(() => {
				speaking = false;
				caption = "";
				updateHint();
			}, 1600);
		} else if (t === "session.delegation.created") {
			activeDelegation = ev.delegation.id;
			const request = inputHeard.trim();
			inputHeard = "";
			panel.querySelector("textarea").value = "";
			if (request) emit({ type: "chat", text: request, voice: true });
			else liveThinking(""); // nothing usable heard; let GPT-Live ask again
		} else if (t === "session.closed") {
			live && stopLive(true);
		}
	}

	// Called on every transcript render: voice the agent's finished narration lines, the final
	// answer, and any approval card, through the active delegation.
	function voiceSync() {
		transcript.forEach((m, i) => {
			if (m.role === "approval") {
				if (m.status === "pending" && lastApprovalVoiced !== m.id) {
					lastApprovalVoiced = m.id;
					commentary(`I've put a change up for approval in the sidebar: ${m.summary} Ask if they want it applied; they can say yes or tap Apply.`);
				}
				return;
			}
			if (m.role !== "assistant") return;
			const key = `m${i}`;
			if (!live) return sentUpTo.set(key, m.text.length);
			const done = sentUpTo.get(key) || 0;
			const finished = !busy || i < transcript.length - 1;
			if (!finished || m.text.length <= done) return;
			const plain = m.text.slice(done).split("\n").filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).join("\n").replace(/\*\*|`|#+\s/g, "");
			commentary(i === transcript.length - 1 && !busy ? `Done. ${plain}` : plain);
			sentUpTo.set(key, m.text.length);
			// Remember where we were, in case a page reload drops the voice session.
			sessionStorage.setItem("trainer-voice-resume", plain.slice(0, 400));
		});
	}

	function updateHint() {
		const h = panel && panel.querySelector(".cbar .hint");
		if (!h) return;
		const wave = `<span class="twave"><i></i><i></i><i></i><i></i><i></i></span>`;
		const mic = panel.querySelector("#t-mic");
		mic.classList.toggle("on", Boolean(live) && !muted);
		mic.title = live ? (muted ? "Unmute" : "Mute") : "Start voice";
		if (connecting) (h.className = "hint live"), (h.innerHTML = `${wave} Connecting voice…`);
		else if (live && speaking) (h.className = "hint live"), (h.innerHTML = `${wave} <span class="cap">${fmt(caption.trim())}</span>`);
		else if (live) (h.className = "hint live"), (h.innerHTML = muted ? "Muted · tap the mic" : `${wave} Listening · just talk`);
		else (h.className = "hint"), (h.textContent = caption || "⌘J to hide");
	}

	function renderChat() {
		if (!msgs) return;
		const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
		msgs.innerHTML = "";
		if (!transcript.length && !hasKey) {
			const e = el(`<div class="tempty"><h3>Almost there</h3>
				<p>ShowMe runs on your own Anthropic API key, stored only in this browser. Add it in settings, plus an OpenAI key if you want voice.</p></div>`);
			const b = el(`<button class="sugg">Open settings</button>`);
			b.onclick = () => bg({ kind: "open-settings" });
			e.appendChild(b);
			msgs.appendChild(e);
		} else if (!transcript.length) {
			const e = el(`<div class="tempty"><h3>What do you want to do?</h3>
				<p>Setting up ERPNext yourself? Ask in your own words. ShowMe does it on this screen so you see where everything lives, and learns how your business works as you go.</p></div>`);
			for (const s of SUGGESTIONS) {
				const b = el(`<button class="sugg"></button>`);
				b.textContent = s;
				b.onclick = () => emit({ type: "chat", text: s });
				e.appendChild(b);
			}
			msgs.appendChild(e);
		}
		for (let i = 0; i < transcript.length; i++) {
			const m = transcript[i];
			if (m.role === "activity") {
				const start = i;
				const items = [];
				while (i < transcript.length && transcript[i].role === "activity") items.push(transcript[i++]);
				i--;
				msgs.appendChild(enter(activityGroup(items, start, busy && i === transcript.length - 1), `g${start}`));
			} else if (m.role === "note") {
				msgs.appendChild(enter(el(`<div class="tnote">${fmt(m.text)}</div>`), `n${i}`));
			} else if (m.role === "cost") {
				const c = el(`<div class="tcost">${fmt(m.text)}</div>`);
				c.title = m.note || "Estimated cost of this task on your API key";
				if (m.calls) c.dataset.calls = m.calls.join(",");
				if (m.cleared) {
					c.dataset.cleared = m.cleared;
					c.title += `\nOld screen readings cleared server-side to keep this fast (${m.cleared.toLocaleString()} tokens).`;
				}
				msgs.appendChild(enter(c, `c${i}`));
			} else if (m.role === "approval") {
				const c = enter(approvalCard(m), `a${i}`);
				enter(c.querySelector(".qs") || c, `a${i}:${m.status}`);
				msgs.appendChild(c);
			} else if (m.role === "assistant") {
				if (m.text.trim()) msgs.appendChild(enter(el(`<div class="tmsg assistant">${md(m.text.trim())}</div>`), `m${i}`));
			} else {
				const u = el(`<div class="tmsg user${m.queued ? " queued" : ""}"></div>`);
				u.textContent = m.text;
				if (m.queued) u.title = "Waiting for the current task to finish";
				msgs.appendChild(enter(u, `m${i}`));
			}
		}
		if (busy && transcript.at(-1)?.role !== "activity" && !(transcript.at(-1)?.role === "assistant" && transcript.at(-1).text.trim()))
			msgs.appendChild(enter(el(`<div class="tgroup"><span class="tdots"><i></i><i></i><i></i></span></div>`), `w${transcript.length}`));
		firstRender = false;
		const sendBtn = panel.querySelector(".send");
		sendBtn.innerHTML = busy ? ICON.stop : ICON.up;
		sendBtn.title = busy ? "Stop" : "Send";
		if (atBottom || busy) msgs.scrollTop = msgs.scrollHeight;
		voiceSync();
	}

	let convId = null;
	function setChat(list, isBusy, conv) {
		ensureUI();
		if (conv) {
			if (conv.id !== convId) {
				// Different conversation: indices mean something else now. No entrance animations, nothing re-voiced.
				convId = conv.id;
				seen.clear();
				openGroups.clear();
				sentUpTo.clear();
				voicePrimed = false;
			}
			panel.querySelector("#t-title").textContent = conv.title && conv.title !== "New conversation" ? conv.title : "Your ERPNext guide";
		}
		transcript = list;
		busy = isBusy;
		// The daemon replays the whole transcript after every page load: treat that first sync as
		// already seen (no entrance animations, nothing re-read aloud).
		if (!voicePrimed) {
			firstRender = true;
			list.forEach((m, i) => m.role === "assistant" && sentUpTo.set(`m${i}`, m.text.length));
			list.forEach((m) => m.role === "approval" && (lastApprovalVoiced = m.id));
			voicePrimed = true;
		}
		renderChat();
	}

	// ---------- History ----------

	const ago = (t) => {
		const s = (Date.now() - t) / 1000;
		if (s < 60) return "just now";
		if (s < 3600) return `${Math.round(s / 60)} min ago`;
		if (s < 86400) return `${Math.round(s / 3600)} h ago`;
		return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
	};

	async function showHistory(open) {
		const box = panel.querySelector("#t-hist");
		panel.querySelector("#t-history").classList.toggle("on", open);
		box.hidden = !open;
		msgs.hidden = open;
		panel.querySelector("form").hidden = open;
		if (!open) return renderChat();
		const { items = [] } = await bg({ kind: "list-conversations" });
		items.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
		box.innerHTML = "";
		const head = el(`<div class="hh"><b>Conversations</b></div>`);
		const nw = el(`<button class="lnk" style="all:unset;cursor:pointer;font-size:13px;color:var(--brand)">+ New</button>`);
		nw.onclick = () => panel.querySelector("#t-new").click();
		head.appendChild(nw);
		box.append(head, el(`<div class="priv">Saved only in this browser, for this site. Never synced.</div>`));
		if (!items.length) box.appendChild(el(`<div class="empty">No saved conversations yet.</div>`));
		for (const it of items) {
			const row = el(`<div class="it${it.current ? " cur" : ""}">
				<div class="tx"><div class="tt"></div><div class="mt">${ago(it.updatedAt)}${it.usd ? ` · ${it.usd < 0.01 ? "<1¢" : it.usd < 1 ? `${Math.round(it.usd * 100)}¢` : `$${it.usd.toFixed(2)}`}` : ""}</div></div>
				${it.pinned ? `<span class="pinned">${ICON.pin}</span>` : ""}
				<div class="ac"><button data-a="pin">${it.pinned ? "Unpin" : "Pin"}</button><button data-a="rename">Rename</button><button data-a="export">Export</button><button data-a="delete">Delete</button></div></div>`);
			row.querySelector(".tt").textContent = it.title;
			row.onclick = async (e) => {
				const a = e.target.dataset?.a;
				e.stopPropagation();
				if (a === "pin") await bg({ kind: "pin-conversation", id: it.id });
				else if (a === "rename") {
					const t = prompt("Rename conversation", it.title);
					if (t) await bg({ kind: "rename-conversation", id: it.id, title: t });
				} else if (a === "export") {
					const r = await bg({ kind: "export-conversation", id: it.id });
					if (r?.markdown) {
						const url = URL.createObjectURL(new Blob([r.markdown], { type: "text/markdown" }));
						const link = Object.assign(document.createElement("a"), { href: url, download: r.filename });
						document.body.appendChild(link);
						link.click();
						link.remove();
						setTimeout(() => URL.revokeObjectURL(url), 2000);
					}
					return;
				} else if (a === "delete") {
					if (!confirm(`Delete "${it.title}"? This can't be undone.`)) return;
					const r = await bg({ kind: "delete-conversation", id: it.id });
					if (r?.error) return alert(r.error);
				} else {
					await bg({ kind: "open-conversation", id: it.id });
					return showHistory(false);
				}
				showHistory(true);
			};
			box.appendChild(row);
		}
	}

	// Inline markdown: **bold**, `code`, *italic*.
	const inline = (s) =>
		fmt(s)
			.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2" target="_blank">$1</a>')
			.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");

	// Block markdown for assistant replies: paragraphs, bullet/numbered lists, tables.
	function md(src) {
		const lines = (src || "").split("\n");
		const out = [];
		let i = 0;
		const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
		while (i < lines.length) {
			const l = lines[i];
			if (/^\s*```/.test(l)) {
				const code = [];
				i++;
				while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
				i++;
				out.push(`<pre>${fmt(code.join("\n"))}</pre>`);
			} else if (/^#{1,4}\s/.test(l)) {
				const n = l.match(/^#+/)[0].length;
				out.push(`<h${n}>${inline(l.replace(/^#+\s*/, ""))}</h${n}>`);
				i++;
			} else if (/^\s*(---|\*\*\*)\s*$/.test(l)) {
				out.push("<hr>");
				i++;
			} else if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
				const head = cells(l);
				i += 2;
				const rows = [];
				while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
				out.push(`<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${rows
					.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
			} else if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
				const ordered = /^\s*\d+\./.test(l);
				const items = [];
				while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
				const tag = ordered ? "ol" : "ul";
				out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
			} else if (l.trim()) {
				const para = [];
				while (i < lines.length && lines[i].trim() && !/^\s*(\||[-*]\s|\d+\.\s|```|#{1,4}\s)/.test(lines[i])) para.push(lines[i++]);
				out.push(`<p>${para.map(inline).join("<br>")}</p>`);
			} else i++;
		}
		return out.join("");
	}

	function thinking(on) {
		if (card) card.querySelector(".thinking").style.display = on ? "block" : "none";
	}

	function find(ref) {
		return ref ? document.querySelector(`[data-tref="${ref}"]`) : null;
	}

	// The element a spotlight should frame: a Frappe field's whole control, not the bare <input>.
	function frameOf(el) {
		return el.closest(".frappe-control") || el;
	}

	function track() {
		if (target && document.contains(target) && visible(target)) {
			const r = frameOf(target).getBoundingClientRect();
			Object.assign(spot.style, {
				display: "block", left: `${r.left - 6}px`, top: `${r.top - 6}px`,
				width: `${r.width + 12}px`, height: `${r.height + 12}px`,
			});
			placeCard(r);
		} else if (spot) {
			spot.style.display = "none";
			if (card && card.style.display === "block") placeCard(null);
		}
		requestAnimationFrame(track);
	}

	function placeCard(r) {
		const W = 340, H = card.offsetHeight || 180, pad = 16, VW = viewW();
		let left, top;
		if (!r) {
			left = VW - W - 24;
			top = innerHeight - H - 24;
		} else {
			left = Math.min(Math.max(r.left, pad), VW - W - pad);
			top = r.bottom + 18;
			if (top + H > innerHeight - pad) top = r.top - H - 18;
			if (top < pad) {
				top = Math.min(Math.max(r.top, pad), innerHeight - H - pad);
				left = r.right + 18 + W < VW ? r.right + 18 : Math.max(r.left - W - 18, pad);
			}
		}
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
	}

	const fmt = (s) =>
		(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

	function button(label, cls, evt) {
		const b = document.createElement("button");
		b.textContent = label;
		if (cls) b.className = cls;
		b.onclick = (e) => {
			e.stopPropagation();
			emit(evt);
			thinking(true);
		};
		return b;
	}

	// mode "watch": the trainer explains, the user presses Next.
	// mode "turn":  the user must do it themselves; we detect their click / input and report it.
	function show({ ref, title, body, step, mode: m = "watch" } = {}) {
		ensureUI();
		thinking(false);
		mode = m;
		target = find(ref);
		if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
		card.querySelector(".step").textContent = step || "";
		card.querySelector(".title").textContent = title || "";
		card.querySelector(".body").innerHTML = fmt(body);
		card.querySelector(".turnhint").textContent =
			mode === "turn" ? (target ? "👉 Your turn: do this on the highlighted spot" : "👉 Your turn") : "";
		spot.classList.toggle("turn", mode === "turn");
		const actions = card.querySelector(".actions");
		actions.innerHTML = "";
		if (mode === "turn") {
			actions.append(button("Show me instead", "", { type: "show_me" }), button("I did it", "primary", { type: "done" }));
		} else {
			actions.append(button("Next →", "primary", { type: "next" }));
		}
		card.style.display = "block";
		return { found: Boolean(target) || !ref };
	}

	function clear() {
		target = null;
		if (card) card.style.display = "none";
		if (spot) spot.style.display = "none";
	}

	// "Your turn" detection: the user clicks the target or changes a field.
	document.addEventListener(
		"click",
		(e) => {
			if (mode !== "turn" || !target || e.target.closest("#trainer-root")) return;
			if (frameOf(target).contains(e.target) || target.contains(e.target)) {
				emit({ type: "did", action: "click", ref: target.dataset.tref, text: clean(target.innerText) });
			}
		},
		true
	);
	document.addEventListener(
		"change",
		(e) => {
			if (e.target.closest && e.target.closest("#trainer-root")) return;
			const field = e.target.closest && e.target.closest("[data-fieldname]");
			if (mode === "turn") {
				emit({ type: "did", action: "change", fieldname: field?.dataset.fieldname, value: e.target.value });
			}
		},
		true
	);

	// Animated cursor for "show me": glide to the element, ripple, then the daemon clicks/types.
	async function pointTo(ref) {
		ensureUI();
		const el = find(ref);
		if (!el) return false;
		el.scrollIntoView({ block: "center" });
		await new Promise((r) => setTimeout(r, 150));
		const r = el.getBoundingClientRect();
		const x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
		if (cursor.style.display !== "block") {
			Object.assign(cursor.style, { display: "block", left: `${innerWidth / 2}px`, top: `${innerHeight / 2}px` });
			await new Promise((r) => setTimeout(r, 30));
		}
		cursor.style.left = `${x}px`;
		cursor.style.top = `${y}px`;
		await new Promise((r) => setTimeout(r, 750));
		Object.assign(ripple.style, { left: `${x}px`, top: `${y}px` });
		ripple.classList.remove("go");
		void ripple.offsetWidth;
		ripple.classList.add("go");
		return true;
	}

	const labelOf = (ref) => {
		const e = find(ref);
		return e ? nameOf(e) : "";
	};

	// ---------- 5. Hands: what the agent's clicks and typing actually do ----------
	// Synthetic pointer/mouse/keyboard events on the real elements. Frappe's handlers (jQuery,
	// awesomplete, its router) see them like a person's input.

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	// Wait until the page stops changing (our own overlay animations don't count).
	async function settle(quiet = 350, max = 5000) {
		const t0 = Date.now();
		let last = Date.now();
		const mo = new MutationObserver((recs) => {
			if (recs.some((r) => !root || !root.contains(r.target))) last = Date.now();
		});
		mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
		await sleep(150);
		while (Date.now() - t0 < max && Date.now() - last < quiet) await sleep(80);
		mo.disconnect();
	}

	function fire(t, type, x, y) {
		const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
		t.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window, pointerType: "mouse", isPrimary: true }));
	}

	async function clickEl(el) {
		el.scrollIntoView({ block: "center" });
		await sleep(100);
		const r = el.getBoundingClientRect();
		const x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
		const top = document.elementFromPoint(x, y);
		const t = top && (el.contains(top) || top.contains(el)) ? top : el;
		for (const type of ["pointerover", "mouseover", "pointerdown", "mousedown"]) fire(t, type, x, y);
		t.focus?.({ preventScroll: true });
		for (const type of ["pointerup", "mouseup"]) fire(t, type, x, y);
		t.click();
	}

	const valueSetter = (el) =>
		Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;

	async function typeInto(el, text, pick) {
		await clickEl(el);
		await sleep(150);
		// Clicking a grid cell (or some controls) swaps in a fresh input: type into what has focus.
		const active = document.activeElement;
		if ((!el.isConnected || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) && active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) el = active;
		if (el.tagName === "SELECT") {
			const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === text.toLowerCase() || o.value === text);
			if (!opt) throw new Error(`No option "${text}" in that dropdown`);
			el.value = opt.value;
			el.dispatchEvent(new Event("change", { bubbles: true }));
			return;
		}
		const fieldtype = el.closest("[data-fieldtype]")?.dataset.fieldtype || "";
		const set = valueSetter(el);
		set.call(el, "");
		el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
		if (/^(Date|Datetime|Time)$/.test(fieldtype)) {
			// Date pickers re-parse on every keystroke and mangle partial input: set it in one go.
			set.call(el, text);
			el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
		} else {
			for (const ch of text) {
				el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
				set.call(el, el.value + ch);
				el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
				el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
				await sleep(55);
			}
		}
		// Only Link-style fields have an autocomplete worth waiting for.
		const hasDropdown = Boolean(el.closest(".awesomplete")) || /Link|MultiSelect/.test(fieldtype);
		if (pick && hasDropdown) {
			let opt = null;
			for (let i = 0; i < 25 && !opt; i++) {
				await sleep(120);
				opt = [...document.querySelectorAll(".awesomplete ul li, .awesomplete [role=option]")]
					.filter(visible)
					.find((li) => li.innerText.toLowerCase().includes(text.toLowerCase()));
			}
			if (opt) {
				opt.dataset.tref ||= `e${nextRef++}`;
				await pointTo(opt.dataset.tref);
				await clickEl(opt);
				return;
			}
		}
		// Commit the value the way leaving the field would.
		el.dispatchEvent(new Event("change", { bubbles: true }));
		if (pick || /^(Date|Datetime|Time)$/.test(fieldtype)) {
			el.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
			el.blur();
		}
	}

	// ---------- 6. Wiring to the background ----------

	chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
		(async () => {
			switch (msg.cmd) {
				case "ping":
					return { ok: isDesk() };
				case "setChat":
					if (isDesk()) setChat(msg.list, msg.busy, msg.conv);
					return {};
				case "snapshot":
					return { text: snapshot(msg.max || 150) };
				case "labelOf":
					return { label: labelOf(msg.ref) };
				case "click": {
					const target = find(msg.ref);
					if (!target) throw new Error(`No element ${msg.ref} on screen any more. Look at the screen again.`);
					await pointTo(msg.ref);
					await clickEl(target);
					await settle();
					return { text: snapshot() };
				}
				case "type": {
					const target = find(msg.ref);
					if (!target) throw new Error(`No element ${msg.ref} on screen any more. Look at the screen again.`);
					await pointTo(msg.ref);
					await typeInto(target, msg.text, msg.pick);
					await settle();
					return { text: snapshot() };
				}
			}
			return {};
		})().then(reply, (e) => reply({ error: String(e.message || e) }));
		return true;
	});

	// A reload or navigation ends a voice call without stopLive(): still count its minutes.
	addEventListener("pagehide", () => live && bg({ kind: "voice-usage", seconds: (Date.now() - live.startedAt) / 1000 }));

	// Keep the service worker awake while it works or a voice call is up (it sleeps after ~30s idle).
	setInterval(() => (busy || live) && bg({ kind: "heartbeat" }), 20000);

	// A key added in settings takes effect without reloading the page.
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && changes.settings) {
			hasKey = Boolean(changes.settings.newValue?.anthropicKey);
			if (msgs) renderChat();
		}
	});

	if (isDesk()) {
		bg({ kind: "hello" }).then((r) => {
			hasKey = r?.hasKey !== false;
			setChat(r?.list || [], Boolean(r?.busy), r?.conv);
		});
	}

	window.__trainer = { snapshot, pointTo, labelOf };
})();
