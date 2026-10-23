/**
 * time_logger_extract_sessions: host-independent core.
 *
 * Shared by the OpenCode 1 entry (.opencode/plugins/time-logger.js) and the
 * OpenCode 2 entry (index.js). It talks to a V1-shaped SDK client
 * (`client.session.get` / `client.session.messages`); the V2 entry passes a shim
 * over its plugin context (src/v2/shim-client.js). Deliberately free of any
 * `@opencode-ai/plugin` import, which OpenCode 2 does not provide.
 */

import {
  extractWorkSessions,
  GAP_MINUTES,
  MIN_MINUTES,
} from "./extract-sessions.js";
import { resolveRootSessionId } from "./resolve-root-session.js";
import { resolveCursorFromMessages } from "./resolve-cursor.js";

export const EXTRACT_DESCRIPTION = [
  "Extract billable work-sessions from the current OpenCode chat for Jira worklog ingestion.",
  "Sessions are split whenever the gap between any two consecutive messages exceeds 15 minutes",
  "(this correctly handles overnight pauses even when only assistant messages bracket the gap).",
  "Each session is clamped to a minimum of 15 minutes and rounded up to the next 15-minute increment.",
  "Returns JSON with per-session start time in Jira's required format (yyyy-MM-dd'T'HH:mm:ss.SSSZ).",
  "Use the returned `start_jira` field as the `started` argument to jira_add_worklog.",
  "The tool keeps a per-session cursor: it reads back its own prior outputs from this chat and, unless you pass an explicit since_ms, returns only work done since the last extraction in this session.",
  "Normally call it with no arguments in both create and append mode.",
  "The session is always inferred from the current chat (auto-resolved to the root parent if invoked from a subagent).",
  "There is no `session_id` argument — you cannot point it at a different chat.",
].join(" ");

/**
 * @param {object} client - V1-shaped SDK client (session.get, session.messages)
 * @param {{ since_ms?: number }} args
 * @param {{ sessionID?: string, metadata?: (m: object) => void }} ctx
 * @param {object} [opts]
 * @param {(items: any[], sessionId: string) => Promise<number|null>|number|null} [opts.readCursor]
 *   Where the auto-cursor comes from. Default: the extractor outputs left in
 *   the session history (the V1 behaviour). The V2 entry also consults plugin
 *   storage, because a compacted V2 history no longer carries those outputs.
 * @param {(sessionId: string, result: object) => Promise<void>|void} [opts.onExtracted]
 *   Called with the result before it is returned (V2 persists the cursor here).
 * @returns {Promise<string>} the extractor JSON
 */
export async function executeExtract(client, args, ctx, opts = {}) {
  // Always infer the session from the tool context — no override arg.
  // Walk parentID upward to the root chat session so subagent contexts
  // (which run in empty child sessions) bill against the right session.
  if (!ctx.sessionID) {
    throw new Error(
      "time_logger_extract_sessions: tool context has no sessionID — cannot infer the chat session",
    );
  }
  const sessionId = await resolveRootSessionId(client, ctx.sessionID);

  const sessionMeta = await client.session.get({
    path: { id: sessionId },
  });
  if (!sessionMeta?.data) {
    throw new Error(
      `time_logger_extract_sessions: session ${sessionId} not found`,
    );
  }

  const messagesResp = await client.session.messages({
    path: { id: sessionId },
  });
  const items = messagesResp?.data ?? [];
  // SDK returns Array<{ info: Message, parts: Part[] }>
  const messages = items
    .map((it) => {
      const info = /** @type {any} */ (it.info);
      if (!info || (info.role !== "user" && info.role !== "assistant"))
        return null;
      return {
        timeMs: info.time?.created,
        role: info.role,
        id: info.id,
      };
    })
    .filter(
      /** @returns {m is {timeMs:number, role:"user"|"assistant", id:string}} */
      (m) => m !== null && typeof m.timeMs === "number",
    );

  // Resolve the cutoff. An explicit since_ms always wins (escape hatch:
  // re-log a slice whose extract advanced the cursor but never reached
  // Jira). Otherwise default to the auto-cursor read back from this
  // session's own prior extract outputs, so we only re-bill work done
  // since the last extraction. Schema already rejects non-positive
  // values, but guard defensively.
  const explicitSinceMs =
    typeof args.since_ms === "number" && args.since_ms > 0
      ? args.since_ms
      : null;
  const readCursor = opts.readCursor ?? ((it) => resolveCursorFromMessages(it));
  const cursorMs = await readCursor(items, sessionId);
  const sinceMs = explicitSinceMs ?? cursorMs;

  const workSessions = extractWorkSessions(messages, sinceMs);

  const totals = {
    work_session_count: workSessions.length,
    billed_minutes: workSessions.reduce(
      (acc, s) => acc + s.billedMinutes,
      0,
    ),
    raw_minutes:
      Math.round(
        workSessions.reduce((acc, s) => acc + s.rawMinutes, 0) * 100,
      ) / 100,
  };

  const meta = /** @type {any} */ (sessionMeta.data);
  const result = {
    session_id: sessionId,
    title: meta.title,
    directory: meta.directory,
    params: {
      gap_minutes: GAP_MINUTES,
      min_minutes: MIN_MINUTES,
      // Effective cutoff actually applied, plus where it came from.
      since_ms: sinceMs,
      since_ms_source: explicitSinceMs
        ? "explicit"
        : cursorMs != null
          ? "auto_cursor"
          : "none",
    },
    totals,
    work_sessions: workSessions.map((s) => ({
      index: s.index,
      start_ms: s.startMs,
      end_ms: s.endMs,
      start_iso: s.startIso,
      start_jira: s.startJira,
      end_iso: s.endIso,
      raw_minutes: s.rawMinutes,
      billed_minutes: s.billedMinutes,
      jira_time_spent: s.jiraTimeSpent,
      user_message_count: s.userMessageCount,
      assistant_message_count: s.assistantMessageCount,
      first_user_msg_id: s.firstUserMsgId,
    })),
  };

  ctx.metadata?.({
    title: `${workSessions.length} work-session(s), ${totals.billed_minutes}m billed`,
    metadata: totals,
  });
  await opts.onExtracted?.(sessionId, result);
  return JSON.stringify(result, null, 2);
}
