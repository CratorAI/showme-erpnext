// A small tool-use loop over the Anthropic Messages API (streaming). Runs in the extension's
// service worker with the user's own API key; no server in between.

const API = "https://api.anthropic.com/v1/messages";
const MAX_STEPS = 40;
const KEEP_RECENT_RESULTS = 4; // older screen snapshots are replaced by a stub to keep context small

/**
 * Run one user turn to completion: call the model, execute any tools, repeat until it stops.
 * `messages` is the running API history and is mutated in place.
 */
export async function runTurn({ apiKey, model, system, tools, messages, signal, onText, onTextBlockStart, onUsage, executeTool }) {
	for (let step = 0; step < MAX_STEPS; step++) {
		trimOldResults(messages);
		const { content, stopReason, usage } = await streamOnce({ apiKey, model, system, tools, messages, signal, onText, onTextBlockStart });
		onUsage?.(usage);
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
			results.push({
				type: "tool_result",
				tool_use_id: block.id,
				content: out.image
					? [{ type: "image", source: { type: "base64", media_type: "image/png", data: out.image } }]
					: out.text || "(no output)",
				...(out.isError ? { is_error: true } : {}),
			});
		}
		messages.push({ role: "user", content: results });
	}
	throw new Error(`Stopped after ${MAX_STEPS} steps`);
}

async function streamOnce({ apiKey, model, system, tools, messages, signal, onText, onTextBlockStart }) {
	const body = {
		model,
		max_tokens: 4096,
		stream: true,
		// Cache the long, stable parts (system prompt + tool definitions) and the conversation so far.
		system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
		tools: tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t)),
		messages: withCacheBreakpoint(messages),
	};
	const res = await fetch(API, {
		method: "POST",
		signal,
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(err.error?.message || `Anthropic API error ${res.status}`);
	}

	const blocks = [];
	let stopReason = null;
	// Input-side counts arrive on message_start, the final output count on message_delta.
	const usage = {};
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
			} else if (ev.type === "error") {
				throw new Error(ev.error?.message || "Anthropic stream error");
			}
		}
	}
	return { content: blocks.filter(Boolean).filter((b) => b.type !== "text" || b.text), stopReason, usage };
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

// Screen snapshots are big and go stale fast; keep only the most recent few in full.
function trimOldResults(messages) {
	const results = [];
	for (const m of messages) {
		if (m.role !== "user" || typeof m.content === "string") continue;
		for (const b of m.content) if (b.type === "tool_result") results.push(b);
	}
	for (const b of results.slice(0, -KEEP_RECENT_RESULTS)) {
		if (Array.isArray(b.content)) b.content = "[earlier screenshot omitted]";
		else if (typeof b.content === "string" && b.content.length > 600) {
			b.content = b.content.slice(0, 300) + "\n… [earlier screen omitted; look again if you need it]";
		}
	}
}
