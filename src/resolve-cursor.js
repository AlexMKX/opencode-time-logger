/**
 * Read the auto-cursor out of the session's own history.
 *
 * Every `time_logger_extract_sessions` call leaves a completed ToolPart in the
 * session whose `state.output` is the extractor's JSON. That output IS the
 * cursor: the latest billed `end_ms` across all prior extracts in this session.
 * On the next call we read it back and default `since_ms` to it, so a session
 * only ever re-bills work done since its last extraction — without any external
 * state file and without consulting Jira (which would be wrong for tickets
 * worked on from several sessions in parallel).
 *
 * Cursor lookup is per-session by construction: we only ever scan the messages
 * of the current root session. Compaction does not threaten this — it trims the
 * model's operated context, not the persisted history the SDK returns here.
 *
 * Pure function — no I/O. The caller passes the already-fetched
 * client.session.messages() items (Array<{ info, parts }>).
 */

/**
 * @param {Array<{ info?: any, parts?: any[] }>} items
 *   session-messages items as returned by client.session.messages()
 * @returns {number|null} the max billed end_ms across prior extracts, or null
 */
export function resolveCursorFromMessages(items) {
  if (!Array.isArray(items)) return null;

  let cursor = null;
  for (const item of items) {
    const parts = item?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const endMs = maxEndMsOfExtractPart(part);
      if (endMs !== null && (cursor === null || endMs > cursor)) {
        cursor = endMs;
      }
    }
  }
  return cursor;
}

/**
 * If `part` is a completed extractor tool-output, return the max end_ms of its
 * work-sessions; otherwise null. Identification is by output signature
 * (params.gap_minutes + work_sessions array), which is robust to the tool name
 * being namespaced by the plugin runtime. Malformed output is skipped, never
 * thrown.
 * @param {any} part
 * @returns {number|null}
 */
function maxEndMsOfExtractPart(part) {
  if (!part || part.type !== "tool") return null;
  const state = part.state;
  if (!state || state.status !== "completed") return null;
  if (typeof state.output !== "string") return null;

  let parsed;
  try {
    parsed = JSON.parse(state.output);
  } catch {
    return null;
  }
  if (!isExtractorOutput(parsed)) return null;

  let max = null;
  for (const s of parsed.work_sessions) {
    const endMs = s?.end_ms;
    if (typeof endMs === "number" && Number.isFinite(endMs)) {
      if (max === null || endMs > max) max = endMs;
    }
  }
  return max;
}

/**
 * Our distinctive output signature: a params object carrying the hard-coded
 * gap_minutes plus a work_sessions array. Distinctive enough to identify our
 * own tool parts without relying on an exact (and namespaced) tool name.
 * @param {any} v
 * @returns {boolean}
 */
function isExtractorOutput(v) {
  return (
    v != null &&
    typeof v === "object" &&
    v.params != null &&
    typeof v.params === "object" &&
    typeof v.params.gap_minutes === "number" &&
    Array.isArray(v.work_sessions)
  );
}
