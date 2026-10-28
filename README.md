# Crator for ERPNext

**An AI copilot that lives inside your ERPNext.** Ask in plain words ("raise a purchase request for 100 kg of
steel", "which customers owe us money?") and watch it happen on your screen: an animated cursor opens the right
page, fills the form and saves the draft, while it explains each step. Talk to it if you like. When something's
missing from your setup, it proposes the change, applies it after you approve, and shows it to you.

It's a Chrome extension. It works with **any ERPNext you can open in Chrome** (Frappe Cloud, self-hosted,
localhost) without installing anything on the server. It runs on **your own API keys**; nothing passes through
a third-party server.

<!-- TODO: demo GIF recorded on a demo site (no customer data) -->

## What it does

- **Does it on screen, so you learn where things live.** It uses ERPNext's own screens with a visible cursor,
  not hidden API calls. It finds pages through the search bar the way you would.
- **Translates your words.** "Purchase request" becomes **Material Request**, "GRN" becomes **Purchase
  Receipt**, and so on. It says the mapping once, then gets on with it.
- **Answers questions about your data.** It opens the relevant list or report, reads the numbers and states them.
- **Voice (optional).** Talk to it and it talks back, narrating while the cursor moves. You can interrupt it.
  Uses OpenAI's GPT-Live.
- **Setup changes, with your approval (optional).** Custom fields, field rules, client and server scripts,
  notifications, workflows. First it checks whether standard ERPNext already does what you want. Each change
  shows an Apply / Cancel card, is logged, can be undone, and is demonstrated on screen once applied.
- **Knows your business through skills.** Add markdown files (like a `SKILL.md`) that describe how *your*
  ERPNext is set up: your names, warehouses, rules, custom fields. See [`examples/skills`](examples/skills).

## Install

1. **Get the code:** `git clone https://github.com/<org>/crator-for-erpnext` (or download the ZIP and unzip it).
2. **Load it in Chrome:** open `chrome://extensions`, turn on **Developer mode** (top right), click **Load
   unpacked** and choose the `extension` folder.
3. **Add your keys:** click the Crator icon → **Settings, keys & skills**.
   - **Anthropic API key** (required), from [console.anthropic.com](https://console.anthropic.com).
   - **OpenAI API key** (optional, for voice), from [platform.openai.com](https://platform.openai.com).
4. **Turn it on for your site:** open your ERPNext, click the Crator icon → **Turn on for this site**.
   Chrome asks for permission for that site only.
5. Reload the page. The sidebar opens on the desk. **⌘J / Ctrl+J** shows or hides it.

Works with ERPNext / Frappe v15 and v16 desks.

## Skills: teach it your setup

In settings, drop in `.md` files or paste them. Optional frontmatter, then anything you'd tell a new colleague:

```markdown
---
name: buying-process
description: How we buy raw material and who approves it
---

- "Indent" means Material Request. The store keeper raises them; POs over ₹50,000 need the director.
- Everything we buy lands in "Main Godown - AT". Never use "Stores - AT".
- Customer has a custom field `credit_days`; respect it in payment terms.
```

Each skill applies to all sites or to one site. Small skill sets go straight into the agent's instructions.
For larger ones, the agent gets an index and reads a skill when it's relevant.

## Safety

It acts **as you, with your ERPNext permissions**, in your browser session. Recommended: try it on a test copy of
your site first.

- **Drafts only by default.** It saves drafts and asks before submitting. Clicking **Submit, Cancel, Delete or
  Amend** always shows an approval card first (you can turn this off in settings).
- **Setup changes are off by default.** When you turn them on, every change needs your Apply, is all-or-nothing,
  is listed in settings, and can be undone by asking ("undo that change").
- **Your keys** stay in this browser's extension storage (`chrome.storage.local`) and are sent only to
  `api.anthropic.com` / `api.openai.com`.
- **Your data:** what the agent reads (screen summaries, query results) goes to Anthropic, and to OpenAI if you
  use voice, under your own accounts and their API data policies.
- **Only on sites you turn on.** The extension asks for permission per site.

## How it works

```
 Your ERPNext tab                                            Extension service worker
 ┌──────────────────────────────────────────┐               ┌───────────────────────────────────────┐
 │ content.js                               │   messages    │ background.js                          │
 │  • sidebar, approval cards, animations   │◀─────────────▶│  • agent loop (agent.js) → Anthropic   │
 │  • "eyes": snapshot → "e12 textbox …"    │               │  • tools, approvals, change log        │
 │  • "hands": cursor + pointer/key events  │               │  • skills, site context (prompts.js)   │
 │  • voice: GPT-Live over WebRTC           │               │  • creates GPT-Live sessions → OpenAI  │
 └──────────────────────────────────────────┘               └───────────────────────────────────────┘
          ▲  Frappe's JS API (frappe, cur_frm) via chrome.scripting in the page's main world
```

- **Seeing:** the page is summarised as one line per visible control with a short ref, its label, field name
  and value. That's much smaller than HTML and enough for the model to act on.
- **Acting:** an animated cursor glides to the element, then real-looking pointer, mouse and keyboard events
  fire, so Frappe's own handlers (autocomplete, grid editing, the router) react as they would to a person.
  For fiddly widgets and for reading data it uses Frappe's client API (`frappe.db.get_list`,
  `cur_frm.set_value`, report filters).
- **Thinking:** a small tool-use loop over the Messages API (Claude Sonnet by default), with prompt caching
  and old screen summaries trimmed to keep long sessions cheap.
- **Voice:** GPT-Live handles the conversation. When you ask for something, it hands the task to the agent
  (client delegation), and the agent's step-by-step narration flows back for it to say aloud.

## Costs

You pay your providers directly, and Crator shows what each task cost right under the answer
(e.g. `2.8¢ · 23k tokens · 70% cached · 5 steps`), with monthly totals per site in settings.

On Claude Sonnet 5.5, answering a data question measured 1.5–3¢. Filling and saving a form (an estimate,
10–15 steps) should be roughly 5–10¢. Prompt caching keeps follow-ups cheap. Voice (GPT-Live) is billed per minute
by OpenAI; Crator counts the minutes. Prices live in [`extension/pricing.js`](extension/pricing.js).

## Development

No build step: edit the files in `extension/` and click reload on `chrome://extensions`.

End-to-end check against a real site (loads the extension in Playwright's Chromium with a throwaway profile):

```bash
npm install && npx playwright install chromium
ANTHROPIC_API_KEY=… ERP_URL=http://localhost:8080 ERP_USER=Administrator ERP_PASS=admin \
ASK="Which customers owe us money?" npm run e2e
```

Need a test ERPNext? [frappe_docker](https://github.com/frappe/frappe_docker)'s `pwd.yml` starts one with
`docker compose -f pwd.yml up -d` (login Administrator / admin). Tick "Generate demo data" in the setup wizard.

## Limitations

- Desk only (`/app`, `/desk`), not the website or portal pages.
- Sites whose Content-Security-Policy forbids `eval` break `run_js` (stock Frappe allows it).
- Server Scripts are disabled on many hosted plans; that one kind of setup change will fail there.
- A full page reload drops a voice call. It reconnects with a short summary of what just happened.

## License

[MIT](LICENSE)
