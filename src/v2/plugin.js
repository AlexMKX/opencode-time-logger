/**
 * opencode-time-logger for OpenCode 2.
 *
 * Same tools and skills as the OpenCode 1 entry (.opencode/plugins/time-logger.js),
 * wired to the V2 plugin API:
 *   - skills: registered via ctx.skill.transform (V2 has no config hook);
 *   - tools: registered via ctx.tool.transform with JSON Schema inputs, running
 *     the same cores as V1 through a V1-shaped shim client;
 *   - message timeline + extraction cursor: kept in plugin storage, because V2
 *     only exposes the post-compaction window of a chat (see ./timeline.js).
 *
 * Loaded by OpenCode 2 through the package root index.js. Must not import
 * `@opencode-ai/plugin` or zod (neither is provided by the V2 host).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTRACT_DESCRIPTION, executeExtract } from "../extract-core.js";
import { resolveCursorFromMessages } from "../resolve-cursor.js";
import {
  REFER_SUBCHAT_DESCRIPTION,
  executeReferSubchat,
} from "../../packages/refer-subchat/src/tool-core.js";
import { withDeadline } from "../../packages/refer-subchat/src/summarize-transcript.js";
import { createShimClient } from "./shim-client.js";
import { loadSkills } from "./skills.js";
import { createTimelineRecorder, mergeTimeline } from "./timeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const SKILLS_DIRS = [
  path.join(PACKAGE_ROOT, "skills"),
  path.join(PACKAGE_ROOT, "packages", "refer-subchat", "skills"),
];

/** @param {string} sessionID */
const cursorKey = (sessionID) => `cursor/${sessionID}`;

export const EXTRACT_INPUT = {
  type: "object",
  properties: {
    since_ms: {
      type: "integer",
      exclusiveMinimum: 0,
      description:
        "Exclude messages at or before this epoch-ms. NORMALLY OMIT THIS: the tool " +
        "keeps a per-session cursor (the end of its last extraction in this chat) " +
        "and applies it automatically, so append mode needs no argument. Pass an " +
        "explicit value ONLY to re-log a slice whose extract advanced the cursor " +
        "but never reached Jira (e.g. a cancelled preview). An explicit value " +
        "overrides the auto-cursor. Must be a positive epoch-ms — do NOT pass 0.",
    },
  },
  additionalProperties: false,
};

export const REFER_SUBCHAT_INPUT = {
  type: "object",
  properties: {
    session_id: {
      type: "string",
      minLength: 1,
      description:
        "Which chat to reference. OMIT to get a listing of chats in the current " +
        "project (id, title, updated time). Pass a session id from that listing " +
        "to get a summary (and, with keywords, ±3-line context windows) of that " +
        "chat. You can only reference chats in the CURRENT project — ids from " +
        "other projects are rejected.",
    },
    keywords: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description:
        "Optional case-insensitive substrings to locate in the referenced chat. " +
        "For each hit the tool returns the surrounding ±3 lines. Ignored in " +
        "listing mode (no session_id).",
    },
    lines_only: {
      type: "boolean",
      description:
        "If true, return ONLY the keyword context windows and skip summarization " +
        "entirely (cheap, no model call). Requires keywords. Use when you just " +
        "need the exact surrounding lines, not a summary.",
    },
  },
  additionalProperties: false,
};

/**
 * One summarization pass without a throwaway session: V2 can generate text
 * directly. Same contract as summarize-transcript's own summarizeOnce.
 * @param {any} ctx
 */
export function generatePass(ctx) {
  return async (_client, { system, text, focus, model, signal, timeoutMs }) => {
    const focusLine = focus ? `Pay special attention to anything about: ${focus}.\n\n` : "";
    const res = await withDeadline(
      ctx.generate.text({
        prompt: `${system}\n\n${focusLine}${text}`,
        ...(model ? { model: { providerID: model.providerID, id: model.modelID } } : {}),
      }),
      timeoutMs,
      signal,
    );
    return (res?.text ?? res?.data?.text ?? "").trim();
  };
}

/**
 * V2 tool context -> the V1 fields the cores read.
 * @param {any} context
 */
const toV1ToolContext = (context) => ({
  sessionID: context.sessionID,
  agent: context.agent,
  abort: context.signal,
});

export default {
  id: "opencode-time-logger",
  async setup(ctx) {
    const skills = loadSkills(SKILLS_DIRS);
    const timeline = createTimelineRecorder(ctx.storage);

    const events = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: events.signal })) {
        timeline.observe(event);
      }
    })().catch(() => {
      // Stream closed (unload) or failed; extraction falls back to context().
    });

    const extractClient = createShimClient(ctx, {
      augmentItems: async (sessionID, items) => mergeTimeline(await timeline.load(sessionID), items),
    });
    const referClient = createShimClient(ctx, { compaction: true });

    // Cursor: the larger of the stored one and any extractor output still in
    // the live window (the latter covers chats migrated from OpenCode 1, whose
    // cursor lives only in their history).
    const readCursor = async (items, sessionID) => {
      const fromHistory = resolveCursorFromMessages(items);
      let stored = null;
      try {
        const v = await ctx.storage.get(cursorKey(sessionID));
        stored = typeof v === "number" ? v : null;
      } catch {
        // Fall back to the history cursor.
      }
      if (stored === null) return fromHistory;
      if (fromHistory === null) return stored;
      return Math.max(stored, fromHistory);
    };
    const onExtracted = async (sessionID, result) => {
      const ends = result.work_sessions.map((s) => s.end_ms).filter((v) => typeof v === "number");
      if (ends.length === 0) return;
      const next = Math.max(...ends);
      const prev = await ctx.storage.get(cursorKey(sessionID)).catch(() => null);
      if (typeof prev !== "number" || next > prev) {
        await ctx.storage.set(cursorKey(sessionID), next);
      }
    };

    await ctx.skill.transform((editor) => {
      for (const skill of skills) {
        if (!editor.get(skill.id)) editor.add(skill);
      }
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "time_logger_extract_sessions",
        description: EXTRACT_DESCRIPTION,
        input: EXTRACT_INPUT,
        execute: async (input, context) => ({
          content: await executeExtract(extractClient, input ?? {}, toV1ToolContext(context), {
            readCursor,
            onExtracted,
          }),
        }),
      });
      editor.add({
        name: "refer_subchat",
        description: REFER_SUBCHAT_DESCRIPTION,
        input: REFER_SUBCHAT_INPUT,
        execute: async (input, context) => ({
          content: await executeReferSubchat(referClient, input ?? {}, toV1ToolContext(context), {
            summarizeOnce: generatePass(ctx),
          }),
        }),
      });
    });

    return async () => {
      events.abort();
      await timeline.flush();
    };
  },
};
