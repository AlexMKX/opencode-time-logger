import { describe, expect, test } from "bun:test";
import { flattenTranscript } from "../src/flatten-transcript.js";

const textItem = (role, id, text) => ({
  info: { role, id },
  parts: [{ type: "text", text }],
});

const toolItem = (role, id, toolName, output) => ({
  info: { role, id },
  parts: [{ type: "tool", tool: toolName, state: { status: "completed", output } }],
});

describe("flattenTranscript", () => {
  test("non-array input -> empty", () => {
    expect(flattenTranscript(null)).toEqual({ lines: [], text: "" });
    expect(flattenTranscript(undefined)).toEqual({ lines: [], text: "" });
  });

  test("splits text parts into physical lines with global numbering", () => {
    const { lines, text } = flattenTranscript([
      textItem("user", "u1", "hello\nworld"),
      textItem("assistant", "a1", "foo"),
    ]);
    expect(lines.map((l) => l.text)).toEqual(["hello", "world", "foo"]);
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2, 3]);
    expect(lines[0].role).toBe("user");
    expect(lines[2].role).toBe("assistant");
    expect(text).toBe("hello\nworld\nfoo");
  });

  test("drops blank lines but keeps numbering contiguous on kept lines", () => {
    const { lines } = flattenTranscript([textItem("user", "u1", "a\n\n  \nb")]);
    expect(lines.map((l) => l.text)).toEqual(["a", "b"]);
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2]);
  });

  test("ignores non user/assistant roles", () => {
    const { lines } = flattenTranscript([
      { info: { role: "system", id: "s1" }, parts: [{ type: "text", text: "x" }] },
    ]);
    expect(lines).toEqual([]);
  });

  test("tool part included with prefix and truncated per maxToolPartChars", () => {
    const big = "X".repeat(2000);
    const { lines } = flattenTranscript([toolItem("assistant", "a1", "bash", big)], {
      maxToolPartChars: 50,
      maxLineChars: 10000,
    });
    expect(lines.length).toBe(1);
    expect(lines[0].kind).toBe("tool");
    expect(lines[0].text.startsWith("[bash] ")).toBe(true);
    expect(lines[0].text).toContain("…[truncated]");
    // "[bash] " + 50 chars + " …[truncated]"
    expect(lines[0].text.length).toBeLessThan(80);
  });

  test("includeToolParts:false drops tool parts", () => {
    const { lines } = flattenTranscript(
      [textItem("user", "u1", "keep"), toolItem("assistant", "a1", "bash", "drop")],
      { includeToolParts: false },
    );
    expect(lines.map((l) => l.text)).toEqual(["keep"]);
  });

  test("caps overlong single line at maxLineChars", () => {
    const { lines } = flattenTranscript([textItem("user", "u1", "y".repeat(1000))], {
      maxLineChars: 20,
    });
    expect(lines[0].text.length).toBe(22); // 20 + " …"
    expect(lines[0].text.endsWith(" …")).toBe(true);
  });

  test("empty/whitespace text parts produce no lines", () => {
    const { lines } = flattenTranscript([
      textItem("user", "u1", ""),
      { info: { role: "assistant", id: "a1" }, parts: [{ type: "text" }] },
    ]);
    expect(lines).toEqual([]);
  });
});
