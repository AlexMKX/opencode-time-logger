/**
 * In-process transcript summarization via a throwaway OpenCode session.
 *
 * The whole point of refer-subchat: a referenced chat may be huge, so we must
 * NOT hand its transcript to the calling agent. Instead the plugin summarizes
 * it here, inside Node, and returns only the resulting summary string.
 *
 * Mechanism (smoke-tested against opencode 1.17):
 *   - session.create a temp session (title prefixed so discovery can hide it)
 *   - session.prompt with tools disabled + a hard summarizer system prompt
 *     (this suppresses the agentic loop — the model just writes text)
 *   - read the assistant text, session.delete in finally
 *
 * Large transcripts use map-reduce: chunk → summarize each chunk → summarize the
 * concatenated chunk-summaries. One reduce level suffices for realistic chats;
 * if the concatenation is still over budget we recurse the reduce.
 *
 * This module owns the summarization ORCHESTRATION but takes the SDK client as
 * a dependency, so it is unit-testable with a fake client. The pure chunking
 * lives in chunk-text.js.
 */

import { chunkText, DEFAULT_MAX_CHARS } from "./chunk-text.js";

export const TEMP_TITLE_PREFIX = "[refer-subchat-tmp]";

const MAP_SYSTEM =
  "You are a transcript summarizer. You are given part of a chat transcript " +
  "between a user and an AI coding assistant. Write a dense, factual summary of " +
  "what happens in this part: decisions made, problems solved, files/tools touched, " +
  "and any conclusions. Do NOT use tools. Do NOT take any action. Output only the summary.";

const REDUCE_SYSTEM =
  "You are a transcript summarizer. You are given several partial summaries of " +
  "one chat transcript, in order. Merge them into a single coherent summary that " +
  "preserves the important decisions, outcomes, and open questions. Do NOT use tools. " +
  "Output only the merged summary.";

/**
 * Extract assistant text from a session.prompt response.
 * @param {any} resp
 */
function replyText(resp) {
  const parts = resp?.data?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * Run one summarization pass in a fresh temp session, always cleaning it up.
 *
 * @param {object} client - OpenCode SDK client
 * @param {object} opts
 * @param {string} opts.directory
 * @param {string} opts.system
 * @param {string} opts.text            - the content to summarize
 * @param {string} [opts.focus]         - optional keyword focus hint
 * @param {{ providerID: string, modelID: string }|null} [opts.model]
 * @returns {Promise<string>}
 */
async function summarizeOnce(client, { directory, system, text, focus, model }) {
  const created = await client.session.create({
    query: { directory },
    body: { title: TEMP_TITLE_PREFIX },
  });
  const tempId = created?.data?.id;
  if (!tempId) throw new Error("summarizeOnce: failed to create temp session");

  try {
    const focusLine = focus
      ? `Pay special attention to anything about: ${focus}.\n\n`
      : "";
    const body = {
      system,
      tools: {},
      parts: [{ type: "text", text: `${focusLine}${text}` }],
    };
    if (model) body.model = model;

    const resp = await client.session.prompt({
      path: { id: tempId },
      query: { directory },
      body,
    });
    return replyText(resp);
  } finally {
    try {
      await client.session.delete({
        path: { id: tempId },
        query: { directory },
      });
    } catch {
      // Best-effort cleanup; a leaked temp session is filtered from discovery
      // by its title prefix anyway.
    }
  }
}

/**
 * Summarize a transcript, map-reducing if it exceeds the char budget.
 *
 * @param {object} client
 * @param {object} opts
 * @param {string} opts.text                     - flattened transcript text
 * @param {string} opts.directory
 * @param {{ providerID: string, modelID: string }|null} [opts.model]
 * @param {string} [opts.focus]                  - keyword focus hint
 * @param {number} [opts.maxChars=DEFAULT_MAX_CHARS]
 * @param {number} [opts.maxReduceDepth=3]       - safety cap on reduce recursion
 * @returns {Promise<{ summary: string, passes: number, chunks: number }>}
 */
export async function summarizeTranscript(client, opts) {
  const {
    text,
    directory,
    model = null,
    focus,
    maxChars = DEFAULT_MAX_CHARS,
    maxReduceDepth = 3,
  } = opts;

  if (typeof text !== "string" || text.trim().length === 0) {
    return { summary: "(empty transcript — nothing to summarize)", passes: 0, chunks: 0 };
  }

  const chunks = chunkText(text, maxChars);

  // Single-pass fast path.
  if (chunks.length <= 1) {
    const summary = await summarizeOnce(client, {
      directory,
      system: MAP_SYSTEM,
      text: chunks[0] ?? text,
      focus,
      model,
    });
    return { summary, passes: 1, chunks: 1 };
  }

  // Map: summarize each chunk.
  let passes = 0;
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    const s = await summarizeOnce(client, {
      directory,
      system: MAP_SYSTEM,
      text: `Part ${i + 1} of ${chunks.length}:\n\n${chunks[i]}`,
      focus,
      model,
    });
    passes += 1;
    partials.push(`--- Part ${i + 1} summary ---\n${s}`);
  }

  // Reduce: fold partial summaries, recursing if still over budget.
  let reduced = partials.join("\n\n");
  let depth = 0;
  while (reduced.length > maxChars && depth < maxReduceDepth) {
    const reChunks = chunkText(reduced, maxChars);
    if (reChunks.length <= 1) break;
    const next = [];
    for (const c of reChunks) {
      const s = await summarizeOnce(client, {
        directory,
        system: REDUCE_SYSTEM,
        text: c,
        focus,
        model,
      });
      passes += 1;
      next.push(s);
    }
    reduced = next.join("\n\n");
    depth += 1;
  }

  const summary = await summarizeOnce(client, {
    directory,
    system: REDUCE_SYSTEM,
    text: reduced,
    focus,
    model,
  });
  passes += 1;

  return { summary, passes, chunks: chunks.length };
}
