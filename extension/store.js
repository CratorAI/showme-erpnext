// Conversations, stored in this browser's IndexedDB (never synced, never sent anywhere but the model
// provider). Two stores, versioned from day one:
//   conversations: the list (id, site, title, timestamps, pinned, cost), indexed by site + updatedAt
//   transcripts:   one record per conversation, { id, ui, api, frozen }
//     ui     - what the thread card shows (and exports); never rewritten, so it stays the full original
//     api    - the model's history; replaced by a compaction block when a conversation gets long
//     frozen - the system prompt and tools the conversation started with (changing them mid-conversation
//              would invalidate the model's earlier reasoning and the prompt cache)

const DB = "showme";
const VERSION = 1;

let dbp = null;
function db() {
	dbp ||= new Promise((resolve, reject) => {
		const req = indexedDB.open(DB, VERSION);
		req.onupgradeneeded = (e) => {
			const d = req.result;
			if (e.oldVersion < 1) {
				const c = d.createObjectStore("conversations", { keyPath: "id" });
				c.createIndex("site_updated", ["site", "updatedAt"]);
				d.createObjectStore("transcripts", { keyPath: "id" });
			}
			// Future versions: add `if (e.oldVersion < 2) { … }` blocks here, never edit the ones above.
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbp;
}

const done = (req) => new Promise((resolve, reject) => {
	req.onsuccess = () => resolve(req.result);
	req.onerror = () => reject(req.error);
});

async function tx(stores, mode, fn) {
	const d = await db();
	const t = d.transaction(stores, mode);
	const result = await fn(...[].concat(stores).map((s) => t.objectStore(s)));
	await new Promise((resolve, reject) => {
		t.oncomplete = resolve;
		t.onerror = () => reject(t.error);
		t.onabort = () => reject(t.error);
	});
	return result;
}

export const getConversation = (id) => tx("conversations", "readonly", (c) => done(c.get(id)));
export const getTranscript = (id) => tx("transcripts", "readonly", (t) => done(t.get(id)));

export function saveConversation(meta, transcript) {
	return tx(["conversations", "transcripts"], "readwrite", (c, t) => {
		c.put(meta);
		if (transcript) t.put({ id: meta.id, ...transcript });
	});
}

export function updateMeta(id, patch) {
	return tx("conversations", "readwrite", async (c) => {
		const cur = await done(c.get(id));
		if (cur) c.put({ ...cur, ...patch });
		return cur && { ...cur, ...patch };
	});
}

// Newest first, for one site.
export function listConversations(site, limit = 200) {
	return tx("conversations", "readonly", async (c) => {
		const range = IDBKeyRange.bound([site, 0], [site, Infinity]);
		const out = [];
		await new Promise((resolve, reject) => {
			const req = c.index("site_updated").openCursor(range, "prev");
			req.onsuccess = () => {
				const cur = req.result;
				if (!cur || out.length >= limit) return resolve();
				out.push(cur.value);
				cur.continue();
			};
			req.onerror = () => reject(req.error);
		});
		return out;
	});
}

export function deleteConversation(id) {
	return tx(["conversations", "transcripts"], "readwrite", (c, t) => {
		c.delete(id);
		t.delete(id);
	});
}

// Delete all conversations (optionally one site's), keeping pinned ones unless `includePinned`.
export async function deleteAll({ site = null, includePinned = false } = {}) {
	const all = await tx("conversations", "readonly", (c) => done(c.getAll()));
	const doomed = all.filter((m) => (!site || m.site === site) && (includePinned || !m.pinned));
	await tx(["conversations", "transcripts"], "readwrite", (c, t) => {
		for (const m of doomed) {
			c.delete(m.id);
			t.delete(m.id);
		}
	});
	return doomed.length;
}

// Retention: drop unpinned conversations not touched for `days`.
export async function prune(days) {
	if (!days) return 0;
	const cutoff = Date.now() - days * 864e5;
	const all = await tx("conversations", "readonly", (c) => done(c.getAll()));
	const old = all.filter((m) => !m.pinned && m.updatedAt < cutoff);
	await tx(["conversations", "transcripts"], "readwrite", (c, t) => {
		for (const m of old) {
			c.delete(m.id);
			t.delete(m.id);
		}
	});
	return old.length;
}

export async function stats() {
	const all = await tx("conversations", "readonly", (c) => done(c.getAll()));
	const est = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
	return { count: all.length, sites: new Set(all.map((m) => m.site)).size, usage: est.usage, quota: est.quota };
}
