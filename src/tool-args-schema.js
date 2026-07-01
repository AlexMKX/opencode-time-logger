/**
 * Zod schema fields for the time_logger_extract_sessions tool args.
 *
 * Extracted into a standalone module so tests can import and validate the
 * schema without pulling in the OpenCode plugin runtime (@opencode-ai/plugin).
 *
 * session_id is intentionally absent: the tool always infers the current chat
 * session from ctx.sessionID and walks parentID upward to the root.
 */

import { z } from "zod";

/**
 * Raw zod field definitions (plain object, not z.object yet).
 * The plugin wraps these with tool({ args: argsSchema }); tests wrap them
 * with z.object(argsSchema) directly.
 */
export const argsSchema = {
  since_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Exclude messages at or before this epoch-ms. NORMALLY OMIT THIS: the tool " +
        "keeps a per-session cursor (the end of its last extraction in this chat) " +
        "and applies it automatically, so append mode needs no argument. Pass an " +
        "explicit value ONLY to re-log a slice whose extract advanced the cursor " +
        "but never reached Jira (e.g. a cancelled preview). An explicit value " +
        "overrides the auto-cursor. Must be a positive epoch-ms — do NOT pass 0.",
    ),
};

/** Convenience: the fully-wrapped z.object for direct safeParse usage. */
export const argsZ = z.object(argsSchema);
