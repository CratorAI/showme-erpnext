// A small tool-use loop over the Anthropic Messages API (streaming). Runs in the extension's
// service worker with the user's own API key; no server in between.

const API = "https://api.anthropic.com/v1/messages";
const MAX_STEPS = 40;
// Context editing (old tool results cleared server-side) and on-demand compaction (summaries).
// History is append-only on our side: rewriting earlier turns would invalidate the model's earlier
// reasoning and the prompt cache, so trimming is left to these server-side features.
const BETAS = "context-management-2025-06-27,compact-2026-09-04";
const MAX_TOOL_OUTPUT = 12000; // bound tool results BEFORE they're first sent, never after

const headers = (apiKey) => ({
	"content-type": "application/json",
	"x-api-key": apiKey,
	"anthropic-version": "2023-06-01",
	"anthropic-beta": BETAS,
	"anthropic-dangerous-direct-browser-access": "true",
});

/**
 * Run one user turn to completion: call the model, execute any tools, repeat until it stops.
 * `messages` is the running API history and is mutated in place.
 */
export async function runTurn({ apiKey, model, system, tools, messages, contextManagement, signal, onText, onTextBlockStart, onUsage, onEdits, executeTool }) {
	for (let step = 0; step < MAX_STEPS; step++) {
		const { content, stopReason, usage, edits } = await streamOnce({ apiKey, model, system, tools, messages, contextManagement, signal, onText, onTextBlockStart });
		onUsage?.(usage);
		if (edits?.length) onEdits?.(edits);
		messages.push({ role: "assistant", content });
		if (stopReason !== "tool_use") return;

		const results = [];
		for (const block of content) {
			if (block.type !== "tool_use") continue;
			if (signal.aborted) throw new DOMException("Stopped", "AbortError");
			let out;
			try {
				out = await executeTool(block.name, block.input || {});
			} catch (e) {
				out = { text: `ERROR: ${String(e.message || e).split("\n")[0]}`, isError: true };
			}
			let text = out.text || "(no output)";
			if (text.length > MAX_TOOL_OUTPUT) text = `${text.slice(0, MAX_TOOL_OUTPUT)}\n… [cut at ${MAX_TOOL_OUTPUT} characters; ask for less, e.g. fewer fields or rows]`;
			results.push({
				type: "tool_result",
				tool_use_id: block.id,
				content: out.image ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: out.image } }] : text,
				...(out.isError ? { is_error: true } : {}),
			});
		}
		messages.push({ role: "user", content: results });
	}
	throw new Error(`Stopped after ${MAX_STEPS} steps`);
}

async function streamOnce({ apiKey, model, system, tools, messages, contextManagement, signal, onText, onTextBlockStart }) {
	const body = {
		model,
		max_tokens: 4096,
		stream: true,
		// Cache the long, stable parts (system prompt + tool definitions) and the conversation so far.
		system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
		tools: tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t)),
		messages: withCacheBreakpoint(messages),
		...(contextManagement ? { context_management: contextManagement } : {}),
	};
	const res = await fetch(API, { method: "POST", signal, headers: headers(apiKey), body: JSON.stringify(body) });
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(err.error?.message || `Anthropic API error ${res.status}`);
	}

	const blocks = [];
	let stopReason = null;
	// Input-side counts arrive on message_start, the final output count on message_delta.
	const usage = {};
	let edits = null;
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let i;
		while ((i = buf.indexOf("\n\n")) >= 0) {
			const chunk = buf.slice(0, i);
			buf = buf.slice(i + 2);
			const line = chunk.split("\n").find((l) => l.startsWith("data: "));
			if (!line) continue;
			const ev = JSON.parse(line.slice(6));
			if (ev.type === "message_start") {
				Object.assign(usage, ev.message?.usage || {});
			} else if (ev.type === "content_block_start") {
				const b = ev.content_block;
				blocks[ev.index] = b.type === "tool_use" ? { ...b, _json: "" } : { ...b };
				if (b.type === "text") onTextBlockStart?.();
			} else if (ev.type === "content_block_delta") {
				const b = blocks[ev.index];
				if (ev.delta.type === "text_delta") {
					b.text += ev.delta.text;
					onText?.(ev.delta.text);
				} else if (ev.delta.type === "input_json_delta") b._json += ev.delta.partial_json;
				// Thinking blocks must go back to the API exactly as received (text + signature).
				else if (ev.delta.type === "thinking_delta") b.thinking = (b.thinking || "") + ev.delta.thinking;
				else if (ev.delta.type === "signature_delta") b.signature = (b.signature || "") + ev.delta.signature;
			} else if (ev.type === "content_block_stop") {
				const b = blocks[ev.index];
				if (b.type === "tool_use") {
					b.input = b._json ? JSON.parse(b._json) : {};
					delete b._json;
				}
			} else if (ev.type === "message_delta") {
				stopReason = ev.delta.stop_reason || stopReason;
				if (ev.usage) Object.assign(usage, ev.usage);
				if (ev.context_management?.applied_edits) edits = ev.context_management.applied_edits;
			} else if (ev.type === "error") {
				throw new Error(ev.error?.message || "Anthropic stream error");
			}
		}
	}
	return { content: blocks.filter(Boolean).filter((b) => b.type !== "text" || b.text), stopReason, usage, edits };
}

// Mark the last block of the conversation as a cache breakpoint (on a copy; history stays clean).
function withCacheBreakpoint(messages) {
	if (!messages.length) return messages;
	const out = messages.slice();
	const last = out[out.length - 1];
	const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content.slice();
	content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: "ephemeral" } };
	out[out.length - 1] = { ...last, content };
	return out;
}

/**
 * On-demand compaction: summarise the whole history into one signed block that replaces it.
 * Same model, system and tools as the conversation (the summariser reads them; it never runs tools).
 * Returns { ok, message, usage } where message is the new single-message history, or { ok:false, reason }.
 */
export async function compact({ apiKey, model, system, tools, messages, instructions }) {
	const res = await fetch(API, {
		method: "POST",
		headers: headers(apiKey),
		body: JSON.stringify({
			model,
			max_tokens: 6000,
			system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
			tools,
			messages,
			compaction: { type: "summarize", instructions },
		}),
	});
	const j = await res.json().catch(() => ({}));
	if (!res.ok) return { ok: false, reason: j.error?.message || `HTTP ${res.status}` };
	// Billing is reported per iteration; the top-level counts are zero for a compaction call.
	const usage = (j.usage?.iterations || []).reduce(
		(u, it) => ({ input_tokens: u.input_tokens + (it.input_tokens || 0), output_tokens: u.output_tokens + (it.output_tokens || 0), cache_read_input_tokens: u.cache_read_input_tokens + (it.cache_read_input_tokens || 0), cache_creation_input_tokens: u.cache_creation_input_tokens + (it.cache_creation_input_tokens || 0) }),
		{ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
	);
	if (j.stop_reason !== "compaction" || !j.content?.length) return { ok: false, reason: j.stop_reason, usage };
	return { ok: true, message: { role: "assistant", content: j.content }, usage };
}

// Small, cheap one-shot call (titles). Thinking off, a handful of output tokens.
export async function quick({ apiKey, model, prompt, maxTokens = 40 }) {
	const res = await fetch(API, {
		method: "POST",
		headers: headers(apiKey),
		body: JSON.stringify({ model, max_tokens: maxTokens, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] }),
	});
	const j = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(j.error?.message || `HTTP ${res.status}`);
	return { text: (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim(), usage: j.usage || {} };
}
