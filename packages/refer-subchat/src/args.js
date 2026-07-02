/**
 * Zod schema fields for the refer_subchat tool args.
 *
 * Extracted so tests can validate the schema without the plugin runtime.
 *
 * There is intentionally NO project/directory/model argument: the project is
 * inferred from the tool context (and used to reject cross-project access), and
 * the summarization model is resolved/pinned by the tool.
 */

import { z } from "zod";

export const argsSchema = {
  session_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Which chat to reference. OMIT to get a listing of chats in the current " +
        "project (id, title, updated time). Pass a session id from that listing " +
        "to get a summary (and, with keywords, ±3-line context windows) of that " +
        "chat. You can only reference chats in the CURRENT project — ids from " +
        "other projects are rejected.",
    ),
  keywords: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional case-insensitive substrings to locate in the referenced chat. " +
        "For each hit the tool returns the surrounding ±3 lines. Ignored in " +
        "listing mode (no session_id).",
    ),
  lines_only: z
    .boolean()
    .optional()
    .describe(
      "If true, return ONLY the keyword context windows and skip summarization " +
        "entirely (cheap, no model call). Requires keywords. Use when you just " +
        "need the exact surrounding lines, not a summary.",
    ),
};

export const argsZ = z.object(argsSchema);
