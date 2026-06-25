/**
 * Zod schema fields for the time_logger_extract_sessions tool args.
 *
 * Extracted into a standalone module so tests can import and validate the
 * schema without pulling in the OpenCode plugin runtime (@opencode-ai/plugin).
 */

import { z } from "zod";

/**
 * Raw zod field definitions (plain object, not z.object yet).
 * The plugin wraps these with tool({ args: argsSchema }); tests wrap them
 * with z.object(argsSchema) directly.
 */
export const argsSchema = {
  session_id: z
    .string()
    .trim()
    .regex(/^ses_[A-Za-z0-9]+$/)
    .optional()
    .describe(
      "OpenCode session id (must match ^ses_…$). " +
        "OMIT this parameter entirely if you don't have a specific session id to target — " +
        "do NOT pass an empty string. " +
        "Defaults to the current chat session (auto-resolved to the root parent if invoked from a subagent).",
    ),

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
