/**
 * Shape the session.list() output into a compact, project-scoped listing.
 *
 * Project isolation is enforced here: only sessions whose projectID matches the
 * current one survive. Our own throwaway summarization sessions (title prefixed
 * with TEMP_TITLE_PREFIX) are hidden, and — by default — child/subagent sessions
 * (those with a parentID) are dropped so the listing shows real top-level chats.
 *
 * Pure function — no I/O.
 */

import { TEMP_TITLE_PREFIX } from "./summarize-transcript.js";
import { toIso } from "./extract-sessions.js";

/**
 * @param {Array<any>} sessions   - client.session.list() data (Array<Session>)
 * @param {string} currentProjectID
 * @param {object} [opts]
 * @param {boolean} [opts.includeChildren=false] - keep sessions that have a parentID
 * @returns {Array<{ id: string, title: string, updated_ms: number, updated_iso: string, parent_id?: string }>}
 *   sorted by updated time, newest first.
 */
export function listProjectSessions(sessions, currentProjectID, opts = {}) {
  const includeChildren = opts.includeChildren === true;
  if (!Array.isArray(sessions) || !currentProjectID) return [];

  return sessions
    .filter((s) => s && s.projectID === currentProjectID)
    .filter((s) => !(typeof s.title === "string" && s.title.startsWith(TEMP_TITLE_PREFIX)))
    .filter((s) => includeChildren || !s.parentID)
    .map((s) => {
      const updatedMs =
        typeof s.time?.updated === "number"
          ? s.time.updated
          : typeof s.time?.created === "number"
            ? s.time.created
            : 0;
      const entry = {
        id: s.id,
        title: typeof s.title === "string" ? s.title : "(untitled)",
        updated_ms: updatedMs,
        updated_iso: updatedMs ? toIso(updatedMs) : null,
      };
      if (s.parentID) entry.parent_id = s.parentID;
      return entry;
    })
    .sort((a, b) => b.updated_ms - a.updated_ms);
}
