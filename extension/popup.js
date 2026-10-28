// Toolbar popup: turn ShowMe on or off for the ERPNext site in the current tab.
const $ = (id) => document.getElementById(id);
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const url = tab?.url ? new URL(tab.url) : null;
const pattern = url && /^https?:$/.test(url.protocol) ? `${url.origin}/*` : null;

$("settings").onclick = () => chrome.runtime.openOptionsPage();

const { settings = {} } = await chrome.storage.local.get("settings");
$("keys").textContent = settings.anthropicKey
	? settings.openaiKey ? "Anthropic and OpenAI keys set. Voice is available." : "Anthropic key set. Add an OpenAI key in settings for voice."
	: "No Anthropic API key yet: add one in settings.";

async function render() {
	$("actions").innerHTML = "";
	if (!pattern) {
		$("site").textContent = "This page";
		$("explain").textContent = "Open your ERPNext in this tab, then click the ShowMe icon again.";
		return;
	}
	$("site").textContent = url.host;
	const on = await chrome.permissions.contains({ origins: [pattern] });
	$("state").textContent = on ? "on" : "off";
	$("state").className = on ? "pill ok" : "pill";
	if (on) {
		$("explain").textContent = "ShowMe's bar sits at the bottom of this site's desk. ⌘J / Ctrl+J shows or hides it.";
		const off = document.createElement("button");
		off.textContent = "Turn off for this site";
		off.onclick = async () => {
			await chrome.permissions.remove({ origins: [pattern] });
			chrome.tabs.reload(tab.id);
			render();
		};
		$("actions").append(off);
	} else {
		$("explain").textContent =
			"ShowMe needs permission to run on this site. It acts as you, with your ERPNext permissions, and asks before submitting or changing your setup.";
		const btn = document.createElement("button");
		btn.className = "primary";
		btn.textContent = "Turn on for this site";
		btn.onclick = async () => {
			// Must be called from this click (a user gesture).
			const granted = await chrome.permissions.request({ origins: [pattern] });
			if (!granted) return;
			await chrome.runtime.sendMessage({ kind: "site-enabled", tabId: tab.id });
			render();
		};
		$("actions").append(btn);
	}
}
render();
