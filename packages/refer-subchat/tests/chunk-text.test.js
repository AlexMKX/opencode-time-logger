import { describe, expect, test } from "bun:test";
import { chunkText, DEFAULT_MAX_CHARS } from "../src/chunk-text.js";

describe("chunkText", () => {
  test("empty / non-string -> []", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText(null)).toEqual([]);
    expect(chunkText(undefined)).toEqual([]);
  });

  test("under budget -> single chunk unchanged", () => {
    expect(chunkText("hello\nworld", 1000)).toEqual(["hello\nworld"]);
  });

  test("splits on line boundaries within budget", () => {
    // each line "aaaa" (4) + newline; budget 10 -> 2 lines per chunk (4+1+4=9)
    const text = ["aaaa", "bbbb", "cccc", "dddd", "eeee"].join("\n");
    const chunks = chunkText(text, 10);
    // never split a line; every chunk <= budget except lone oversized lines
    for (const c of chunks) {
      for (const line of c.split("\n")) expect(line.length).toBeLessThanOrEqual(10);
    }
    // reassembling all lines preserves order & content
    expect(chunks.join("\n").split("\n")).toEqual(text.split("\n"));
  });

  test("respects budget (no chunk exceeds it when lines fit)", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const chunks = chunkText(text, 15);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("oversized single line becomes its own chunk", () => {
    const big = "z".repeat(100);
    const text = `small\n${big}\nsmall2`;
    const chunks = chunkText(text, 20);
    expect(chunks).toContain(big);
    // content preserved
    expect(chunks.join("\n").split("\n")).toEqual(["small", big, "small2"]);
  });

  test("default budget is applied when omitted", () => {
    const text = "x".repeat(DEFAULT_MAX_CHARS + 10);
    const chunks = chunkText(text);
    // one oversized line -> stays a single chunk (can't split a line)
    expect(chunks.length).toBe(1);
  });

  test("invalid maxChars falls back to default", () => {
    expect(chunkText("short", -5)).toEqual(["short"]);
    expect(chunkText("short", 0)).toEqual(["short"]);
  });
});
