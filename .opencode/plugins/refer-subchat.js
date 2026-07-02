/**
 * refer-subchat: the `refer_subchat` tool factory.
 *
 * Lets an agent pull knowledge out of ANOTHER chat in the SAME project without
 * loading that chat's (possibly huge) transcript into its own context:
 *
 *   - no session_id            -> a compact listing of this project's chats
 *   - session_id               -> a summary of that chat (+ ±3-line keyword
 *                                 windows if keywords are given)
 *   - session_id + lines_only  -> only the keyword windows (no model call)
 *
 * Project isolation is a hard security boundary: the current project is derived
 * from ctx.sessionID (never from an argument), and any requested session_id is
 * rejected unless its projectID matches. Summarization happens in-process in a
 * throwaway session (see src/summarize-transcript.js), so the transcript never
 * reaches the calling agent.
 *
 * This module exports a factory rather than a standalone PluginModule: OpenCode
 * loads a plugin package through its single `main` entry (time-logger.js), so
 * the tool is registered there by merging in `createReferSubchatTool(client)`.
 *
 * Deliberately thin: all reusable logic (flattening, windowing, chunking, model
 * resolution, listing, summarization orchestration) lives in src/ with unit
 * tests. Here we only wire the SDK together.
 */

import { tool } from "@opencode-ai/plugin";
import { resolveRootSessionId } from "../../src/resolve-root-session.js";
import { flattenTranscript } from "../../src/flatten-transcript.js";
import { keywordWindows, renderWindows } from "../../src/keyword-windows.js";
import { resolveSummaryModel } from "../../src/resolve-summary-model.js";
import { listProjectSessions } from "../../src/list-project-sessions.js";
import { summarizeTranscript } from "../../src/summarize-transcript.js";
import { argsSchema } from "../../src/refer-subchat-args.js";

/** Resolve the current project id from the tool context's session. */
async function currentProjectId(client, ctxSessionId) {
  const rootId = await resolveRootSessionId(client, ctxSessionId);
  const resp = await client.session.get({ path: { id: rootId } });
  const projectID = resp?.data?.projectID;
  if (!projectID) {
    throw new Error(
      `refer_subchat: could not resolve projectID for session ${rootId}`,
    );
  }
  return { projectID, directory: resp?.data?.directory };
}

/**
 * Build the refer_subchat tool bound to a given SDK client.
 * @param {object} client - OpenCode SDK client
 * @returns {Record<string, any>} tool map to merge into a plugin's `tool` field
 */
export function createReferSubchatTool(client) {
  return {
    refer_subchat: tool({
        description: [
          "Reference ANOTHER chat in the current project without loading its full transcript into your context.",
          "Call with no arguments to list the project's chats (id, title, updated time); pick one and call again with its session_id.",
          "With a session_id you get an in-process summary of that chat; add keywords to also get the ±3 lines around each hit.",
          "Pass lines_only:true (with keywords) to skip the summary and get only those context windows cheaply.",
          "You can only reach chats in the CURRENT project — session ids from other projects are rejected.",
          "The transcript is summarized inside the tool, so a huge chat costs you only a small summary in return.",
        ].join(" "),
        args: argsSchema,
        execute: async (args, ctx) => {
          if (!ctx.sessionID) {
            throw new Error(
              "refer_subchat: tool context has no sessionID — cannot resolve the current project",
            );
          }

          const { projectID, directory } = await currentProjectId(
            client,
            ctx.sessionID,
          );

          // ---- Listing mode -------------------------------------------------
          if (!args.session_id) {
            const listResp = await client.session.list({
              query: { directory },
            });
            const sessions = listResp?.data ?? [];
            const chats = listProjectSessions(sessions, projectID);
            ctx.metadata?.({
              title: `${chats.length} chat(s) in project`,
              metadata: { chat_count: chats.length },
            });
            return JSON.stringify(
              {
                mode: "listing",
                project_id: projectID,
                chat_count: chats.length,
                chats,
                hint: "Call refer_subchat again with one of these `id` values as session_id.",
              },
              null,
              2,
            );
          }

          // ---- Reference mode ----------------------------------------------
          const keywords = Array.isArray(args.keywords)
            ? args.keywords.filter((k) => typeof k === "string" && k.length > 0)
            : [];
          const linesOnly = args.lines_only === true;
          if (linesOnly && keywords.length === 0) {
            throw new Error(
              "refer_subchat: lines_only requires at least one keyword",
            );
          }

          // Authoritative project check on the requested target.
          const targetResp = await client.session.get({
            path: { id: args.session_id },
          });
          const target = targetResp?.data;
          if (!target) {
            throw new Error(
              `refer_subchat: session ${args.session_id} not found`,
            );
          }
          if (target.projectID !== projectID) {
            throw new Error(
              `refer_subchat: session ${args.session_id} belongs to a different project — access denied`,
            );
          }

          const messagesResp = await client.session.messages({
            path: { id: args.session_id },
          });
          const items = messagesResp?.data ?? [];

          // Two intentionally different views of the same transcript:
          //  - grep: full tool output (the user may search a command dump far
          //    past the summary cap), with a generous per-line bound so long
          //    single lines stay searchable while a pathological minified blob
          //    is still capped.
          //  - summary: tool output truncated per part so a file dump can't
          //    dominate the summarization budget.
          const windows = keywords.length
            ? keywordWindows(
                flattenTranscript(items, {
                  includeToolParts: true,
                  maxToolPartChars: Infinity,
                  maxLineChars: 2000,
                }).lines,
                keywords,
                3,
              )
            : [];

          if (linesOnly) {
            ctx.metadata?.({
              title: `${windows.length} keyword window(s)`,
              metadata: { window_count: windows.length },
            });
            return JSON.stringify(
              {
                mode: "lines_only",
                session_id: args.session_id,
                title: target.title,
                keywords,
                window_count: windows.length,
                windows_text: renderWindows(windows),
              },
              null,
              2,
            );
          }

          // Summary view: tool output truncated per part (see comment above).
          const { text } = flattenTranscript(items, {
            includeToolParts: true,
            maxToolPartChars: 800,
          });

          const [config, providers] = await Promise.all([
            client.config.get().then((r) => r?.data).catch(() => null),
            client.provider.list().then((r) => r?.data).catch(() => null),
          ]);
          const model = resolveSummaryModel(config, providers);

          const { summary, passes, chunks, timedOut } = await summarizeTranscript(
            client,
            {
              text,
              directory,
              model,
              focus: keywords.length ? keywords.join(", ") : undefined,
              // Wire the tool's abort signal so cancelling the parent turn (or a
              // per-pass timeout) actually tears summarization down instead of
              // hanging the tool — and the whole agent turn — indefinitely.
              signal: ctx.abort,
            },
          );

          ctx.metadata?.({
            title: `summarized ${chunks} chunk(s) in ${passes} pass(es)${timedOut ? `, ${timedOut} timed out` : ""}`,
            metadata: { passes, chunks, timed_out: timedOut, window_count: windows.length },
          });

          return JSON.stringify(
            {
              mode: "summary",
              session_id: args.session_id,
              title: target.title,
              summary_model: model
                ? `${model.providerID}/${model.modelID}`
                : "(default)",
              passes,
              chunks,
              timed_out: timedOut,
              summary,
              keywords,
              window_count: windows.length,
              windows_text: keywords.length ? renderWindows(windows) : undefined,
            },
            null,
            2,
          );
        },
      }),
  };
}
