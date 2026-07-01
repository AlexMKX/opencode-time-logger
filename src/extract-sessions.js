/**
 * Work-session extraction algorithm.
 *
 * Given a chronological list of chat messages (user + assistant), group them
 * into "work-sessions": contiguous stretches separated by quiet gaps larger
 * than GAP_MINUTES (15). Each session is then clamped to MIN_MINUTES (15) and
 * its billable duration is rounded up to the next 15-min increment for
 * Jira-friendly worklog reporting.
 *
 * The gap is computed between any two consecutive messages (not just
 * user->assistant), so an overnight stretch with no user reply still splits
 * the session even if both adjacent messages were produced by the assistant
 * (resume-after-sleep scenario).
 *
 * Pure function — no I/O, no globals. Trivially unit-testable.
 */

/**
 * @typedef {object} ChatMessage
 * @property {number} timeMs   - epoch milliseconds
 * @property {"user"|"assistant"} role
 * @property {string} [id]     - opaque id, preserved on the first user message of each session
 */

/**
 * @typedef {object} WorkSession
 * @property {number} index
 * @property {string|undefined} firstUserMsgId
 * @property {number} startMs
 * @property {number} endMs
 * @property {string} startIso         - ISO 8601 with offset (e.g. 2026-06-17T11:53:34+03:00)
 * @property {string} startJira        - Jira-required format (yyyy-MM-dd'T'HH:mm:ss.SSSZ, offset without colon)
 * @property {string} endIso
 * @property {number} userMessageCount
 * @property {number} assistantMessageCount
 * @property {number} rawMinutes       - actual end-start in minutes (rounded to 2 decimals)
 * @property {number} billedMinutes    - clamped to minMinutes, rounded up to 15-min increments
 * @property {string} jiraTimeSpent    - "1h 15m", "30m", etc.
 */

// Hard-coded behavior. The 15-min gap and 15-min minimum together produce
// realistic work-sessions across observed chats (see project README). They
// are intentionally NOT configurable via tool arguments — every prior bug
// in this plugin came from option plumbing, not from the values themselves.
export const GAP_MINUTES = 15;
export const MIN_MINUTES = 15;

/**
 * @param {ChatMessage[]} messages
 * @param {number|null} [sinceMs=null]  exclude messages at or before this epoch-ms
 *   (the cursor is the end of an already-logged session, so it is exclusive: the
 *   boundary message was already billed). Filtering at the message level — rather
 *   than dropping whole sessions by startMs — lets a session that began before the
 *   cursor but continued past it still yield its post-cursor continuation.
 * @returns {WorkSession[]}
 */
export function extractWorkSessions(messages, sinceMs = null) {
  const gapMs = GAP_MINUTES * 60 * 1000;
  const minMs = MIN_MINUTES * 60 * 1000;
  const cutoff =
    typeof sinceMs === "number" && Number.isFinite(sinceMs) ? sinceMs : null;

  // Pre-filter to roles we care about, drop everything at or before the cursor,
  // then sort by time defensively. The cutoff is applied here (message level) so
  // a continuous session straddling the cursor keeps only its later portion.
  const ordered = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .filter((m) => cutoff == null || m.timeMs > cutoff)
    .slice()
    .sort((a, b) => a.timeMs - b.timeMs);

  /** @type {Array<{firstUserMsgId?: string, startMs: number, endMs: number, userMessageCount: number, assistantMessageCount: number}>} */
  const raw = [];
  /** @type {(typeof raw)[number] | null} */
  let current = null;
  let prevTimeMs = null;

  for (const m of ordered) {
    if (current === null) {
      // Don't open a session on an orphan assistant message — wait for a user turn.
      if (m.role !== "user") continue;
      current = {
        firstUserMsgId: m.id,
        startMs: m.timeMs,
        endMs: m.timeMs,
        userMessageCount: 1,
        assistantMessageCount: 0,
      };
      prevTimeMs = m.timeMs;
      continue;
    }

    const gap = m.timeMs - prevTimeMs;
    if (gap > gapMs) {
      raw.push(current);
      if (m.role === "user") {
        current = {
          firstUserMsgId: m.id,
          startMs: m.timeMs,
          endMs: m.timeMs,
          userMessageCount: 1,
          assistantMessageCount: 0,
        };
      } else {
        // Gap closed the session; assistant alone can't open a new one.
        current = null;
      }
    } else {
      if (m.role === "user") current.userMessageCount += 1;
      else current.assistantMessageCount += 1;
      current.endMs = m.timeMs;
    }
    prevTimeMs = m.timeMs;
  }
  if (current !== null) raw.push(current);

  return raw.map((s, index) => {
    const rawMs = Math.max(0, s.endMs - s.startMs);
    const rawMinutes = Math.round((rawMs / 60000) * 100) / 100;
    const billedMs = Math.max(rawMs, minMs);
    const billedMinutes = Math.ceil(billedMs / 60000 / 15) * 15;
    return {
      index,
      firstUserMsgId: s.firstUserMsgId,
      startMs: s.startMs,
      endMs: s.endMs,
      startIso: toIso(s.startMs),
      startJira: toJiraDateTime(s.startMs),
      endIso: toIso(s.endMs),
      userMessageCount: s.userMessageCount,
      assistantMessageCount: s.assistantMessageCount,
      rawMinutes,
      billedMinutes,
      jiraTimeSpent: toJiraTimeSpent(billedMinutes),
    };
  });
}

/**
 * Local-time ISO 8601 string with offset, e.g. 2026-06-17T11:53:34+03:00.
 * @param {number} ms
 */
export function toIso(ms) {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    offset
  );
}

/**
 * Jira's required `started` format: yyyy-MM-dd'T'HH:mm:ss.SSSZ
 * (millisecond precision, offset without colon, e.g. +0300).
 * @param {number} ms
 */
export function toJiraDateTime(ms) {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${offset}`
  );
}

/**
 * Format minutes as Jira time-spent: "1h 30m", "2h", "45m".
 * @param {number} minutes
 */
export function toJiraTimeSpent(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
