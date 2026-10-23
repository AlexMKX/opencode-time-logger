/**
 * opencode-time-logger plugin entry.
 *
 * Responsibilities:
 *   1. Register the bundled `jira-time-tracker` skill directory so OpenCode
 *      auto-discovers it (no symlinks, no user-side config edits).
 *   2. Register the `time_logger_extract_sessions` tool. The tool reads the
 *      current chat session via the OpenCode SDK (inferred from ctx.sessionID,
 *      walked to the root parent for subagent contexts), groups messages into
 *      work-sessions, and returns Jira-ready JSON.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { tool } from "@opencode-ai/plugin";
import { EXTRACT_DESCRIPTION, executeExtract } from "../../src/extract-core.js";
import { argsSchema } from "../../src/tool-args-schema.js";
import { createReferSubchatTool } from "../../packages/refer-subchat/src/tool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
// Skill directories to auto-register. The refer-subchat skill lives inside its
// own package folder (that package is intended to be extracted into a
// standalone OpenCode plugin), so it is registered as a separate path.
const SKILLS_DIRS = [
  path.join(PACKAGE_ROOT, "skills"),
  path.join(PACKAGE_ROOT, "packages", "refer-subchat", "skills"),
];

/** @type {import("@opencode-ai/plugin").Plugin} */
export const TimeLoggerPlugin = async ({ client }) => {
  return {
    config: async (config) => {
      // Auto-register our bundled skills directories.
      // OpenCode config shape uses `skills.paths` (mirrors superpowers).
      // Cast through any to avoid coupling to private types.
      const cfg = /** @type {any} */ (config);
      cfg.skills = cfg.skills || {};
      cfg.skills.paths = cfg.skills.paths || [];
      for (const dir of SKILLS_DIRS) {
        if (fs.existsSync(dir) && !cfg.skills.paths.includes(dir)) {
          cfg.skills.paths.push(dir);
        }
      }
    },

    tool: {
      // refer_subchat: cross-project-isolated chat summary/grep (own module).
      ...createReferSubchatTool(client),
      time_logger_extract_sessions: tool({
        description: EXTRACT_DESCRIPTION,
        args: argsSchema,
        execute: (args, ctx) => executeExtract(client, args, ctx),
      }),
    },
  };
};

export default { id: "opencode-time-logger", server: TimeLoggerPlugin };
