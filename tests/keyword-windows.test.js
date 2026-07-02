import { describe, expect, test } from "bun:test";
import { keywordWindows, renderWindows } from "../src/keyword-windows.js";

// Build a FlatLine[] from an array of plain strings (role defaults to user).
const mkLines = (texts, role = "user") =>
  texts.map((text, i) => ({
    lineNo: i + 1,
    role,
    msgId: "m1",
    kind: "text",
    text,
  }));

describe("keywordWindows", () => {
  test("no keywords -> no windows", () => {
    expect(keywordWindows(mkLines(["a", "b"]), [])).toEqual([]);
    expect(keywordWindows(mkLines(["a", "b"]), undefined)).toEqual([]);
  });

  test("empty lines -> no windows", () => {
    expect(keywordWindows([], ["x"])).toEqual([]);
  });

  test("single hit expands to ±radius and clamps at edges", () => {
    const lines = mkLines(["l1", "l2", "TARGET", "l4", "l5"]);
    const w = keywordWindows(lines, ["target"], 1);
    expect(w.length).toBe(1);
    expect(w[0].startLine).toBe(2);
    expect(w[0].endLine).toBe(4);
    expect(w[0].lines.map((l) => l.text)).toEqual(["l2", "TARGET", "l4"]);
    expect(w[0].matchedKeywords).toEqual(["target"]);
  });

  test("case-insensitive substring match", () => {
    const lines = mkLines(["nothing", "The Cursor value", "nothing"]);
    const w = keywordWindows(lines, ["CURSOR"], 0);
    expect(w.length).toBe(1);
    expect(w[0].lines.map((l) => l.text)).toEqual(["The Cursor value"]);
  });

  test("clamps at line 1 (no negative)", () => {
    const lines = mkLines(["hit here", "b", "c"]);
    const w = keywordWindows(lines, ["hit"], 3);
    expect(w[0].startLine).toBe(1);
    expect(w[0].endLine).toBe(3);
  });

  test("overlapping/adjacent windows merge into one block", () => {
    // hits at index 2 and 4; radius 1 -> [1..3] and [3..5] -> merge [1..5]
    const lines = mkLines(["a", "b", "HIT1", "d", "HIT2", "f", "g"]);
    const w = keywordWindows(lines, ["hit1", "hit2"], 1);
    expect(w.length).toBe(1);
    expect(w[0].startLine).toBe(2);
    expect(w[0].endLine).toBe(6);
    expect(w[0].matchedKeywords.sort()).toEqual(["hit1", "hit2"]);
  });

  test("distant hits stay separate", () => {
    const lines = mkLines(["HIT", "b", "c", "d", "e", "f", "g", "HIT"]);
    const w = keywordWindows(lines, ["hit"], 1);
    expect(w.length).toBe(2);
    expect(w[0].startLine).toBe(1);
    expect(w[1].endLine).toBe(8);
  });

  test("multiple keywords on one line recorded once", () => {
    const lines = mkLines(["alpha and beta together"]);
    const w = keywordWindows(lines, ["alpha", "beta"], 0);
    expect(w.length).toBe(1);
    expect(w[0].matchedKeywords.sort()).toEqual(["alpha", "beta"]);
  });
});

describe("renderWindows", () => {
  test("empty -> explicit no-match string", () => {
    expect(renderWindows([])).toBe("(no keyword matches)");
  });

  test("renders header with line range and keywords", () => {
    const lines = mkLines(["a", "HIT", "c"], "assistant");
    const out = renderWindows(keywordWindows(lines, ["hit"], 1));
    expect(out).toContain("lines 1–3");
    expect(out).toContain("keywords: hit");
    expect(out).toContain("assistant: HIT");
  });
});
