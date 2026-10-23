/**
 * Message timeline kept in plugin storage (OpenCode 2 only).
 *
 * WHY: billing needs the timestamp of every user and assistant message in a
 * chat. OpenCode 1's `session.messages()` returned the full persisted history.
 * OpenCode 2 exposes only `ctx.session.context()` to plugins, and after a
 * compaction that is the post-compaction window — verified live: the turns
 * before the compaction point are gone from it. Without a record of our own, a
 * compacted chat would silently under-bill.
 *
 * So the plugin listens to the event stream and stores one compact entry per
 * message: a user prompt on `session.inbox.enqueued` (item type "user"), an
 * assistant message on `session.step.started`. Their ids and times match what
 * `context()` reports for the same messages (`inboxID` is the user message id;
 * `started` is the assistant message's `time.created`), so the stored timeline
 * and the live window merge by id without duplicates. Chats older than the
 * plugin install, or edited while it was not loaded, fall back to whatever
 * `context()` still holds.
 */

const KEY_PREFIX = "timeline/";

/** @param {string} sessionID */
export const timelineKey = (sessionID) => `${KEY_PREFIX}${sessionID}`;

/**
 * Map one V2 event to a timeline entry, or null when it is not a message.
 *
 * Pure function — no I/O.
 *
 * @param {any} event
 * @returns {{ sessionID: string, id: string, role: "user"|"assistant", timeMs: number } | null}
 */
export function timelineEntryFromEvent(event) {
  const data = event?.data;
  const sessionID = data?.sessionID;
  if (typeof sessionID !== "string") return null;
  if (event.type === "session.inbox.enqueued" && data.item?.type === "user") {
    if (typeof data.inboxID !== "string" || typeof event.created !== "number") return null;
    return { sessionID, id: data.inboxID, role: "user", timeMs: event.created };
  }
  if (event.type === "session.step.started") {
    if (typeof data.assistantMessageID !== "string") return null;
    const timeMs = typeof data.started === "number" ? data.started : event.created;
    if (typeof timeMs !== "number") return null;
    return { sessionID, id: data.assistantMessageID, role: "assistant", timeMs };
  }
  return null;
}

/**
 * Add stored timeline entries that the live items lack, as part-less items, and
 * return everything in time order. Live items win on a shared id — they carry
 * the parts the transcript readers need.
 *
 * Pure function — no I/O.
 *
 * @param {Array<[string, "u"|"a", number]>|undefined} stored
 * @param {Array<{ info: { id: string, time: { created: number } } }>} items
 */
export function mergeTimeline(stored, items) {
  const seen = new Set(items.map((it) => it?.info?.id).filter(Boolean));
  const merged = [...items];
  for (const entry of Array.isArray(stored) ? stored : []) {
    if (!Array.isArray(entry) || entry.length !== 3) continue;
    const [id, r, timeMs] = entry;
    if (typeof id !== "string" || seen.has(id) || typeof timeMs !== "number") continue;
    seen.add(id);
    merged.push({
      info: { id, role: r === "u" ? "user" : "assistant", time: { created: timeMs } },
      parts: [],
    });
  }
  return merged.sort((a, b) => a.info.time.created - b.info.time.created);
}

/**
 * Buffers timeline entries and writes them to plugin storage in batches, so a
 * burst of steps costs one read-modify-write per session rather than one per
 * event. Sessions known to be subagent children are skipped: billing always
 * resolves to the root chat.
 *
 * @param {{ get(key: string): Promise<any>, set(key: string, value: any): Promise<void> }} storage
 * @param {object} [opts]
 * @param {number} [opts.flushMs=2000]
 */
export function createTimelineRecorder(storage, opts = {}) {
  const flushMs = opts.flushMs ?? 2000;
  /** @type {Map<string, Array<[string, "u"|"a", number]>>} */
  const pending = new Map();
  const children = new Set();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let chain = Promise.resolve();

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const batch = [...pending.entries()];
    pending.clear();
    chain = chain.then(async () => {
      for (const [sessionID, entries] of batch) {
        try {
          const key = timelineKey(sessionID);
          const existing = (await storage.get(key)) ?? [];
          const ids = new Set(existing.map((e) => e?.[0]));
          const next = [...existing];
          for (const e of entries) {
            if (ids.has(e[0])) continue;
            ids.add(e[0]);
            next.push(e);
          }
          if (next.length !== existing.length) await storage.set(key, next);
        } catch {
          // Best-effort: a lost batch only means the live window is all the
          // extractor sees for those messages.
        }
      }
    });
    return chain;
  };

  return {
    /** @param {any} event */
    observe(event) {
      if (event?.type === "session.created" && event.data?.parentID) {
        children.add(event.data.sessionID);
        return;
      }
      const entry = timelineEntryFromEvent(event);
      if (!entry || children.has(entry.sessionID)) return;
      const list = pending.get(entry.sessionID) ?? [];
      list.push([entry.id, entry.role === "user" ? "u" : "a", entry.timeMs]);
      pending.set(entry.sessionID, list);
      if (!timer) {
        timer = setTimeout(flush, flushMs);
        timer.unref?.();
      }
    },
    flush,
    /**
     * Stored timeline for a session, including entries not yet flushed.
     * @param {string} sessionID
     */
    async load(sessionID) {
      await flush();
      try {
        return (await storage.get(timelineKey(sessionID))) ?? [];
      } catch {
        return [];
      }
    },
  };
}
