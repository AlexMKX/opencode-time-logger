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
      "Drop work-sessions starting before this epoch-ms. For append mode: " +
        "set to max(worklog.started_epoch_ms + worklog.timeSpentSeconds*1000) " +
        "from jira_get_worklog. " +
        "Must be a positive epoch-ms; OMIT this parameter if you have no cutoff — do NOT pass 0.",
    ),
};

/** Convenience: the fully-wrapped z.object for direct safeParse usage. */
export const argsZ = z.object(argsSchema);
