/**
 * Standalone OpenCode plugin entry for refer-subchat.
 *
 * This package is currently bundled inside opencode-time-logger: its tool is
 * registered by that package's entry (`.opencode/plugins/time-logger.js`) via
 * `createReferSubchatTool`, and its skill directory is registered by that
 * package's `config` hook. This file is the drop-in entry for when the package
 * is extracted into its own repo/plugin — point the package `main` at it and it
 * self-registers both the tool and the bundled skill.
 *
 * Everything refer-subchat needs lives under this folder (src/, skills/), with
 * shared helpers vendored (resolve-root-session.js, iso.js) so the folder has
 * no dependency on the sibling time-logger code.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createReferSubchatTool } from "./src/tool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(__dirname, "skills");

/** @type {import("@opencode-ai/plugin").Plugin} */
export const ReferSubchatPlugin = async ({ client }) => {
  return {
    config: async (config) => {
      if (!fs.existsSync(SKILLS_DIR)) return;
      const cfg = /** @type {any} */ (config);
      cfg.skills = cfg.skills || {};
      cfg.skills.paths = cfg.skills.paths || [];
      if (!cfg.skills.paths.includes(SKILLS_DIR)) {
        cfg.skills.paths.push(SKILLS_DIR);
      }
    },

    tool: {
      ...createReferSubchatTool(client),
    },
  };
};

export default { server: ReferSubchatPlugin };
