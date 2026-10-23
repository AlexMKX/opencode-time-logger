/**
 * Split a large transcript text into boundary-aligned chunks for map-reduce
 * summarization.
 *
 * We don't do exact token counting (YAGNI for v1); a character budget is a
 * good-enough proxy. Chunks are split on line boundaries so we never cut a line
 * in half. A single line longer than the budget becomes its own (over-budget)
 * chunk rather than being dropped or split mid-word.
 *
 * Pure function — no I/O.
 */

export const DEFAULT_MAX_CHARS = 48000;

/**
 * @param {string} text
 * @param {number} [maxChars=DEFAULT_MAX_CHARS]
 * @returns {string[]}  one or more chunks; empty input yields [].
 */
export function chunkText(text, maxChars = DEFAULT_MAX_CHARS) {
  if (typeof text !== "string" || text.length === 0) return [];
  const budget =
    Number.isFinite(maxChars) && maxChars > 0
      ? Math.floor(maxChars)
      : DEFAULT_MAX_CHARS;

  if (text.length <= budget) return [text];

  const lines = text.split("\n");
  /** @type {string[]} */
  const chunks = [];
  let current = "";

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const line of lines) {
    // +1 accounts for the "\n" we re-insert when joining.
    const addLen = current.length === 0 ? line.length : line.length + 1;
    if (current.length + addLen > budget) {
      flush();
      // A single oversized line: emit it as its own chunk.
      if (line.length > budget) {
        chunks.push(line);
        continue;
      }
      current = line;
    } else {
      current = current.length === 0 ? line : current + "\n" + line;
    }
  }
  flush();

  return chunks;
}
