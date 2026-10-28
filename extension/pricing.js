// Prices come from LiteLLM's open price list (the de facto machine-readable source, keyed by the
// exact model IDs providers use), refreshed once a day. The built-in table below is only a fallback
// for when that fetch fails; it was checked against Anthropic's pricing page on 2026-10-28.
// Either way these are list prices: an estimate, not your invoice.

const SOURCE = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const SOURCE_NAME = "LiteLLM price list";
const REFRESH_MS = 24 * 60 * 60 * 1000;

// USD per million tokens. `tier`: different prices when one request's prompt exceeds `above` tokens.
const FALLBACK = {
	"claude-sonnet-5-5": { in: 2, out: 10, cr: 0.1, cw: 2.5 },
	"claude-opus-5-5": { in: 4, out: 20, cr: 0.2, cw: 5 },
	"claude-haiku-5-5": { in: 0.1, out: 0.5, cr: 0.01, cw: 0.125, tier: { above: 100000, in: 0.5, out: 2.5, cr: 0.05, cw: 0.625 } },
	"claude-fable-5-1": { in: 10, out: 50, cr: 0.25, cw: 12.5 },
};

const M = 1e6;

// Reduce LiteLLM's ~3 MB file to what we use: four prices (+ an optional tier) per model.
export function compact(raw) {
	const table = {};
	for (const [id, v] of Object.entries(raw)) {
		if (!v || typeof v.input_cost_per_token !== "number") continue;
		const base = {
			in: v.input_cost_per_token * M,
			out: (v.output_cost_per_token || 0) * M,
			cr: (v.cache_read_input_token_cost ?? v.input_cost_per_token) * M,
			cw: (v.cache_creation_input_token_cost ?? v.input_cost_per_token) * M,
		};
		const k = Object.keys(v).map((key) => key.match(/^input_cost_per_token_above_(\d+)k_tokens$/)).find(Boolean)?.[1];
		if (k) {
			const at = (f) => v[`${f}_above_${k}k_tokens`];
			base.tier = {
				above: Number(k) * 1000,
				in: at("input_cost_per_token") * M,
				out: (at("output_cost_per_token") ?? v.output_cost_per_token ?? 0) * M,
				cr: (at("cache_read_input_token_cost") ?? v.cache_read_input_token_cost ?? at("input_cost_per_token")) * M,
				cw: (at("cache_creation_input_token_cost") ?? v.cache_creation_input_token_cost ?? at("input_cost_per_token")) * M,
			};
		}
		table[id] = base;
	}
	return table;
}

// { table, source, fetchedAt } from the daily cache, refreshed when stale, built-in if offline.
export async function getPrices({ force = false } = {}) {
	const { prices } = await chrome.storage.local.get("prices");
	if (!force && prices?.table && Date.now() - prices.fetchedAt < REFRESH_MS) return prices;
	try {
		const res = await fetch(SOURCE, { cache: "no-cache" });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const fresh = { table: compact(await res.json()), source: SOURCE_NAME, fetchedAt: Date.now() };
		await chrome.storage.local.set({ prices: fresh });
		return fresh;
	} catch {
		return prices?.table ? prices : { table: FALLBACK, source: "built-in table (offline)", fetchedAt: 0 };
	}
}

// Look a model up by its exact ID (also tolerating a "provider/" prefix); null if unknown.
export function priceFor(prices, model) {
	return prices.table[model] || prices.table[model?.split("/").pop()] || FALLBACK[model] || null;
}

// Cost of ONE API call. Tiers depend on that call's prompt size, so this can't run on summed totals.
export function callCost(price, u) {
	const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
	const p = price.tier && prompt > price.tier.above ? price.tier : price;
	return (
		((u.input_tokens || 0) * p.in +
			(u.output_tokens || 0) * p.out +
			(u.cache_read_input_tokens || 0) * p.cr +
			(u.cache_creation_input_tokens || 0) * p.cw) /
		M
	);
}

export const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });

export function addUsage(total, u) {
	total.input += u.input_tokens || 0;
	total.output += u.output_tokens || 0;
	total.cacheRead += u.cache_read_input_tokens || 0;
	total.cacheWrite += u.cache_creation_input_tokens || 0;
	total.calls += 1;
	return total;
}

export function formatUSD(usd) {
	if (usd == null) return "";
	if (usd < 0.01) return "<1¢";
	if (usd < 1) return `${(usd * 100).toFixed(usd < 0.1 ? 1 : 0)}¢`;
	return `$${usd.toFixed(2)}`;
}

export function formatTokens(n) {
	return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
