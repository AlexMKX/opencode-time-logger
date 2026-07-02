/**
 * Flatten OpenCode `session.messages()` items into a line-oriented view.
 *
 * `session.messages()` returns Array<{ info: Message, parts: Part[] }>. Parts
 * carry not only user/assistant text but also tool inputs/outputs, which can be
 * enormous (file dumps, command output). We convert everything we care about
 * into a flat array of physical lines so downstream code (keyword windows,
 * chunking) can work uniformly.
 *
 * Two knobs guard against a single giant part blowing the budget:
 *   - maxToolPartChars: a tool part's text is truncated to this many chars
 *     before splitting into lines (tool output is context, not the payload).
 *   - maxLineChars: every emitted line is capped to this length, so a minified
 *     blob on one physical line stays bounded.
 *
 * Pure function — no I/O, no globals.
 */

/**
 * @typedef {object} FlatLine
 * @property {number} lineNo   - 1-based global line number across the transcript
 * @property {"user"|"assistant"} role
 * @property {string|undefined} msgId
 * @property {"text"|"tool"} kind  - whether the line came from a text or tool part
 * @property {string} text
 */

const DEFAULTS = {
  // Per-tool-part truncation. Tool output is supporting context; a file dump
  // must not dominate the summary/grep budget.
  maxToolPartChars: 800,
  // Per-line cap so a single minified line can't explode.
  maxLineChars: 400,
  // Whether to include tool parts at all. Summary path may drop them; grep path
  // keeps them (the user might search for something a tool printed).
  includeToolParts: true,
};

/**
 * Extract the plain text carried by a single part, or null if it carries none
 * we care about. Handles the common OpenCode part shapes defensively.
 * @param {any} part
 * @returns {{ kind: "text"|"tool", text: string } | null}
 */
function partText(part) {
  if (!part || typeof part !== "object") return null;

  if (part.type === "text") {
    return typeof part.text === "string" && part.text.length > 0
      ? { kind: "text", text: part.text }
      : null;
  }

  if (part.type === "tool") {
    // Prefer the completed output; fall back to nothing. State shape mirrors
    // resolve-cursor.js (state.status === "completed", state.output string).
    const state = part.state;
    const out =
      state && typeof state.output === "string" ? state.output : null;
    if (out == null || out.length === 0) return null;
    const toolName = part.tool || part.name || "tool";
    return { kind: "tool", text: `[${toolName}] ${out}` };
  }

  return null;
}

/**
 * @param {Array<{ info?: any, parts?: any[] }>} items
 *   session-messages items as returned by client.session.messages()
 * @param {object} [opts]
 * @param {number} [opts.maxToolPartChars]
 * @param {number} [opts.maxLineChars]
 * @param {boolean} [opts.includeToolParts]
 * @returns {{ lines: FlatLine[], text: string }}
 *   `lines` for keyword windows; `text` is the same content joined with "\n"
 *   (convenient for chunking / summarization).
 */
export function flattenTranscript(items, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  /** @type {FlatLine[]} */
  const lines = [];
  let lineNo = 0;

  if (!Array.isArray(items)) return { lines, text: "" };

  for (const item of items) {
    const info = item?.info;
    const role = info?.role;
    if (role !== "user" && role !== "assistant") continue;
    const msgId = typeof info?.id === "string" ? info.id : undefined;
    const parts = Array.isArray(item?.parts) ? item.parts : [];

    for (const part of parts) {
      const pt = partText(part);
      if (pt == null) continue;
      if (pt.kind === "tool" && !cfg.includeToolParts) continue;

      let text = pt.text;
      if (pt.kind === "tool" && text.length > cfg.maxToolPartChars) {
        text = text.slice(0, cfg.maxToolPartChars) + " …[truncated]";
      }

      // Split into physical lines, cap each, preserve blank lines dropped.
      for (const raw of text.split("\n")) {
        const trimmedRight = raw.replace(/\s+$/, "");
        if (trimmedRight.length === 0) continue;
        const capped =
          trimmedRight.length > cfg.maxLineChars
            ? trimmedRight.slice(0, cfg.maxLineChars) + " …"
            : trimmedRight;
        lineNo += 1;
        lines.push({
          lineNo,
          role,
          msgId,
          kind: pt.kind,
          text: capped,
        });
      }
    }
  }

  const text = lines.map((l) => l.text).join("\n");
  return { lines, text };
}
