/**
 * OpenCode 2 session messages -> the OpenCode 1 `{ info, parts }` shape.
 *
 * Every pure helper in this package (extract-sessions, resolve-cursor,
 * flatten-transcript) was written against `client.session.messages()` from
 * OpenCode 1. OpenCode 2's `ctx.session.context()` returns a flat
 * `SessionMessageInfo[]` instead: `type` rather than `info.role`, text on the
 * message itself for user turns, and assistant `content` entries rather than
 * parts. Converting at this edge keeps those helpers — and their tests —
 * unchanged.
 *
 * Pure function — no I/O.
 */

/**
 * Text carried by a completed V2 tool state (`state.content`), joined.
 * @param {any} state
 * @returns {string|undefined}
 */
function toolOutput(state) {
  if (!state || !Array.isArray(state.content)) return undefined;
  const text = state.content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  return text.length > 0 ? text : undefined;
}

/**
 * @param {any} content one entry of a V2 assistant message's `content`
 * @returns {object|null} a V1 part, or null for content V1 consumers ignore
 */
function toPart(content) {
  if (content?.type === "text" && typeof content.text === "string") {
    return { type: "text", text: content.text };
  }
  if (content?.type === "tool") {
    const state = content.state ?? {};
    return {
      type: "tool",
      tool: content.name,
      state: { status: state.status, input: state.input, output: toolOutput(state) },
    };
  }
  return null;
}

/**
 * @param {readonly any[]} messages V2 `SessionMessageInfo[]` from ctx.session.context()
 * @param {object} [opts]
 * @param {boolean} [opts.compaction=false] keep a completed compaction as an
 *   assistant text item carrying its summary. Off for time extraction (the
 *   summary is not activity); on for transcript readers, where the summary is
 *   all that is left of the history it replaced.
 * @returns {Array<{ info: { id: string, role: "user"|"assistant", time: { created: number } }, parts: object[] }>}
 */
export function toV1Items(messages, opts = {}) {
  if (!Array.isArray(messages)) return [];
  const items = [];
  for (const m of messages) {
    const created = m?.time?.created;
    if (typeof created !== "number") continue;
    if (m.type === "user") {
      items.push({
        info: { id: m.id, role: "user", time: { created } },
        parts: typeof m.text === "string" && m.text ? [{ type: "text", text: m.text }] : [],
      });
    } else if (m.type === "assistant") {
      const parts = (Array.isArray(m.content) ? m.content : []).map(toPart).filter(Boolean);
      items.push({ info: { id: m.id, role: "assistant", time: { created } }, parts });
    } else if (
      opts.compaction &&
      m.type === "compaction" &&
      m.status === "completed" &&
      typeof m.summary === "string"
    ) {
      items.push({
        info: { id: m.id, role: "assistant", time: { created } },
        parts: [{ type: "text", text: `[Summary of the earlier conversation]\n${m.summary}` }],
      });
    }
  }
  return items;
}
