/**
 * opencode-time-logger plugin entry.
 *
 * Responsibilities:
 *   1. Register the bundled `jira-time-tracker` skill directory so OpenCode
 *      auto-discovers it (no symlinks, no user-side config edits).
 *   2. Register the `time_logger_extract_sessions` tool. The tool reads the
 *      current (or explicitly-named) chat session via the OpenCode SDK,
 *      groups messages into work-sessions, and returns Jira-ready JSON.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { tool } from "@opencode-ai/plugin";
import {
  extractWorkSessions,
  GAP_MINUTES,
  MIN_MINUTES,
} from "../../src/extract-sessions.js";
import { resolveRootSessionId } from "../../src/resolve-root-session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");

/** @type {import("@opencode-ai/plugin").Plugin} */
export const TimeLoggerPlugin = async ({ client }) => {
  return {
    config: async (config) => {
      // Auto-register our bundled skills directory.
      if (!fs.existsSync(SKILLS_DIR)) return;
      // OpenCode config shape uses `skills.paths` (mirrors superpowers).
      // Cast through any to avoid coupling to private types.
      const cfg = /** @type {any} */ (config);
      cfg.skills = cfg.skills || {};
      cfg.skills.paths = cfg.skills.paths || [];
      if (!cfg.skills.paths.includes(SKILLS_DIR)) {
        cfg.skills.paths.push(SKILLS_DIR);
      }
    },

    tool: {
      time_logger_extract_sessions: tool({
        description: [
          "Extract billable work-sessions from the current OpenCode chat for Jira worklog ingestion.",
          "Sessions are split whenever the gap between any two consecutive messages exceeds 15 minutes",
          "(this correctly handles overnight pauses even when only assistant messages bracket the gap).",
          "Each session is clamped to a minimum of 15 minutes and rounded up to the next 15-minute increment.",
          "Returns JSON with per-session start time in Jira's required format (yyyy-MM-dd'T'HH:mm:ss.SSSZ).",
          "Use the returned `start_jira` field as the `started` argument to jira_add_worklog.",
        ].join(" "),
        args: {
          session_id: tool.schema
            .string()
            .optional()
            .describe(
              "OpenCode session id (ses_...). Defaults to the current chat session.",
            ),
          since_ms: tool.schema
            .number()
            .optional()
            .describe(
              "Drop work-sessions starting before this epoch-ms. For append mode: " +
                "set to max(worklog.started_epoch_ms + worklog.timeSpentSeconds*1000) " +
                "from jira_get_worklog.",
            ),
        },
        execute: async (args, ctx) => {
          // When the caller explicitly passes session_id, use it verbatim
          // (the skill may pass a specific ses_... as an override).
          // Otherwise walk parentID upward to find the root chat session,
          // which is the one that contains all the messages we want to bill —
          // subagents run in child sessions that are empty on their own.
          const rawId = args.session_id ?? ctx.sessionID;
          if (!rawId) {
            throw new Error(
              "time_logger_extract_sessions: no session_id provided and no current sessionID in tool context",
            );
          }
          const sessionId = args.session_id
            ? rawId
            : await resolveRootSessionId(client, rawId);

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

          const workSessions = extractWorkSessions(messages, args.since_ms ?? null);

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
              since_ms: args.since_ms ?? null,
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

          ctx.metadata({
            title: `${workSessions.length} work-session(s), ${totals.billed_minutes}m billed`,
            metadata: totals,
          });
          return JSON.stringify(result, null, 2);
        },
      }),
    },
  };
};

export default { server: TimeLoggerPlugin };
