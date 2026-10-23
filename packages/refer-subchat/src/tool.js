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
import { argsSchema } from "./args.js";
import { REFER_SUBCHAT_DESCRIPTION, executeReferSubchat } from "./tool-core.js";

/**
 * Build the refer_subchat tool bound to a given SDK client.
 * @param {object} client - OpenCode SDK client
 * @returns {Record<string, any>} tool map to merge into a plugin's `tool` field
 */
export function createReferSubchatTool(client) {
  return {
    refer_subchat: tool({
      description: REFER_SUBCHAT_DESCRIPTION,
      args: argsSchema,
      execute: (args, ctx) => executeReferSubchat(client, args, ctx),
    }),
  };
}
