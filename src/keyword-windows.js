/**
 * Build ±N-line context windows around keyword hits in a flattened transcript.
 *
 * Given the FlatLine[] produced by flatten-transcript.js and a list of
 * keywords, find every line that contains any keyword (case-insensitive
 * substring), expand each hit to [i-radius, i+radius], merge overlapping or
 * adjacent ranges, and emit each merged range as a block annotated with the
 * line range and role.
 *
 * Pure function — no I/O.
 */

/**
 * @typedef {import("./flatten-transcript.js").FlatLine} FlatLine
 */

/**
 * @typedef {object} Window
 * @property {number} startLine  - 1-based line number of the first line in the block
 * @property {number} endLine
 * @property {FlatLine[]} lines
 * @property {string[]} matchedKeywords  - keywords that hit inside this block
 */

/**
 * @param {FlatLine[]} lines
 * @param {string[]} keywords
 * @param {number} [radius=3]
 * @returns {Window[]}
 */
export function keywordWindows(lines, keywords, radius = 3) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const needles = (Array.isArray(keywords) ? keywords : [])
    .filter((k) => typeof k === "string" && k.length > 0)
    .map((k) => ({ raw: k, lower: k.toLowerCase() }));
  if (needles.length === 0) return [];

  const r = Number.isInteger(radius) && radius >= 0 ? radius : 3;

  // hitIndex -> the keywords that matched on that line (by array index).
  /** @type {Array<{ idx: number, matched: string[] }>} */
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const hay = lines[i].text.toLowerCase();
    const matched = [];
    for (const n of needles) {
      if (hay.includes(n.lower)) matched.push(n.raw);
    }
    if (matched.length > 0) hits.push({ idx: i, matched });
  }
  if (hits.length === 0) return [];

  // Expand each hit to [idx-r, idx+r], then merge overlapping/adjacent ranges.
  /** @type {Array<{ start: number, end: number, matched: Set<string> }>} */
  const ranges = [];
  for (const h of hits) {
    const start = Math.max(0, h.idx - r);
    const end = Math.min(lines.length - 1, h.idx + r);
    const last = ranges[ranges.length - 1];
    // Adjacent (end+1 >= start) ranges merge into one contiguous block.
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
      for (const m of h.matched) last.matched.add(m);
    } else {
      ranges.push({ start, end, matched: new Set(h.matched) });
    }
  }

  return ranges.map((range) => {
    const block = lines.slice(range.start, range.end + 1);
    return {
      startLine: block[0].lineNo,
      endLine: block[block.length - 1].lineNo,
      lines: block,
      matchedKeywords: [...range.matched],
    };
  });
}

/**
 * Render windows to a compact human/agent-readable string. Kept here (not in
 * the plugin) so it is unit-testable alongside the windowing logic.
 * @param {Window[]} windows
 * @returns {string}
 */
export function renderWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) {
    return "(no keyword matches)";
  }
  return windows
    .map((w) => {
      const header = `— lines ${w.startLine}–${w.endLine} (keywords: ${w.matchedKeywords.join(", ")}) —`;
      const body = w.lines
        .map((l) => `${l.lineNo}\t${l.role}: ${l.text}`)
        .join("\n");
      return `${header}\n${body}`;
    })
    .join("\n\n");
}
