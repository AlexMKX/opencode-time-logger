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

// Hard ceiling per summarization pass. A single stalled model stream must never
// hang the whole tool (and therefore the parent agent turn) forever — observed
// in the wild: a haiku stream stuck mid-pass left refer_subchat "running" for
// 40+ minutes. On timeout we abort the temp session server-side and move on.
export const PASS_TIMEOUT_MS = 120000;

// How many summarization passes run concurrently. Map passes are independent
// (one temp session each), so wall-clock on a big chat drops from sum-of-passes
// to ceil(passes / N). Kept modest to avoid provider rate-limits and a burst of
// temp sessions. A stalled pass no longer blocks the others (only its own slot).
export const MAP_CONCURRENCY = 4;

/**
 * Map an async fn over items with bounded concurrency, preserving input order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function pMapBounded(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

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

/** Sentinel thrown when a pass exceeds PASS_TIMEOUT_MS or the caller aborts. */
export class PassTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "PassTimeoutError";
  }
}

/** Our deadline OR a fetch torn down by the abort signal — both are "give up". */
function isCancellation(err) {
  return err instanceof PassTimeoutError || err?.name === "AbortError";
}

/**
 * Race a promise against a hard timeout and an optional external abort signal.
 * On timeout/abort the losing promise is left to settle on its own (we can't
 * truly cancel an unknown promise), but the caller regains control immediately.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<T>}
 */
function withDeadline(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn) => (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn(v);
    };
    const ok = finish(resolve);
    const fail = finish(reject);
    const onAbort = () => fail(new PassTimeoutError("summarization pass aborted by caller"));
    const timer = setTimeout(
      () => fail(new PassTimeoutError(`summarization pass exceeded ${ms}ms`)),
      ms,
    );
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    promise.then(ok, fail);
  });
}

/**
 * Run one summarization pass in a fresh temp session, always cleaning it up.
 *
 * Bounded by PASS_TIMEOUT_MS and the optional external signal. On timeout/abort
 * the temp session is aborted server-side (to stop a stalled model stream) and
 * then deleted, and a PassTimeoutError is thrown for the caller to handle.
 *
 * @param {object} client - OpenCode SDK client
 * @param {object} opts
 * @param {string} opts.directory
 * @param {string} opts.system
 * @param {string} opts.text            - the content to summarize
 * @param {string} [opts.focus]         - optional keyword focus hint
 * @param {{ providerID: string, modelID: string }|null} [opts.model]
 * @param {AbortSignal} [opts.signal]   - external cancel (e.g. tool ctx.abort)
 * @param {number} [opts.timeoutMs=PASS_TIMEOUT_MS]
 * @returns {Promise<string>}
 */
async function summarizeOnce(
  client,
  { directory, system, text, focus, model, signal, timeoutMs = PASS_TIMEOUT_MS },
) {
  // Even creating the temp session can hang if the server is wedged — bound it
  // too, so there is no unguarded await anywhere on this path.
  const created = await withDeadline(
    client.session.create({ query: { directory }, body: { title: TEMP_TITLE_PREFIX } }),
    timeoutMs,
    signal,
  );
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

    const resp = await withDeadline(
      client.session.prompt({
        path: { id: tempId },
        query: { directory },
        body,
        // Best-effort: pass the signal to the underlying fetch too, so the
        // request is torn down where the SDK honors it.
        ...(signal ? { signal } : {}),
      }),
      timeoutMs,
      signal,
    );
    return replyText(resp);
  } catch (err) {
    // A stalled/aborted stream: stop it server-side so it doesn't keep burning
    // tokens after we've given up on it. Fire-and-forget, bounded. Covers both
    // our own deadline (PassTimeoutError) and a fetch aborted via the signal.
    if (isCancellation(err)) {
      try {
        await withDeadline(
          client.session.abort({ path: { id: tempId }, query: { directory } }),
          10000,
          undefined,
        );
      } catch {
        // ignore — cleanup delete below still runs
      }
    }
    throw err;
  } finally {
    try {
      await withDeadline(
        client.session.delete({ path: { id: tempId }, query: { directory } }),
        10000,
        undefined,
      );
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
    signal,
    passTimeoutMs = PASS_TIMEOUT_MS,
    concurrency = MAP_CONCURRENCY,
  } = opts;

  if (typeof text !== "string" || text.trim().length === 0) {
    return { summary: "(empty transcript — nothing to summarize)", passes: 0, chunks: 0, timedOut: 0 };
  }

  const common = { directory, model, focus, signal, timeoutMs: passTimeoutMs };
  let passes = 0;
  let timedOut = 0;

  // Run one pass, counting it; a PassTimeoutError degrades to null (the caller
  // substitutes a placeholder) so a single stalled stream can't sink the whole
  // summary. Non-timeout errors still propagate.
  const runPass = async (system, chunk) => {
    passes += 1;
    try {
      return await summarizeOnce(client, { ...common, system, text: chunk });
    } catch (err) {
      if (isCancellation(err)) {
        timedOut += 1;
        return null;
      }
      throw err;
    }
  };

  const chunks = chunkText(text, maxChars);

  // Single-pass fast path.
  if (chunks.length <= 1) {
    const summary = await runPass(MAP_SYSTEM, chunks[0] ?? text);
    return {
      summary: summary ?? "(summarization timed out before any output was produced)",
      passes,
      chunks: 1,
      timedOut,
    };
  }

  // Map: summarize chunks concurrently (each in its own temp session), order
  // preserved. A stalled/aborted chunk degrades to a placeholder without
  // blocking the rest.
  const mapped = await pMapBounded(chunks, concurrency, (chunk, i) =>
    signal?.aborted
      ? null
      : runPass(MAP_SYSTEM, `Part ${i + 1} of ${chunks.length}:\n\n${chunk}`),
  );
  const partials = mapped.map(
    (s, i) => `--- Part ${i + 1} summary ---\n${s ?? "(this part timed out and was skipped)"}`,
  );

  // Reduce: fold partial summaries, recursing if still over budget. The chunks
  // within a level are independent too, so fold them concurrently.
  let reduced = partials.join("\n\n");
  let depth = 0;
  while (reduced.length > maxChars && depth < maxReduceDepth && !signal?.aborted) {
    const reChunks = chunkText(reduced, maxChars);
    if (reChunks.length <= 1) break;
    const folded = await pMapBounded(reChunks, concurrency, (c) =>
      signal?.aborted ? null : runPass(REDUCE_SYSTEM, c),
    );
    // On timeout keep the pre-reduce text rather than lose it.
    reduced = folded.map((s, i) => s ?? reChunks[i]).join("\n\n");
    depth += 1;
  }

  const summary = await runPass(REDUCE_SYSTEM, reduced);
  return {
    // If the final fold timed out, fall back to the concatenated partials so the
    // caller still gets usable content instead of nothing.
    summary: summary ?? reduced,
    passes,
    chunks: chunks.length,
    timedOut,
  };
}
