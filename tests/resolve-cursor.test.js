import { describe, expect, test } from "bun:test";
import { resolveCursorFromMessages } from "../src/resolve-cursor.js";

// Build a session-messages item ({ info, parts }) carrying a single tool part
// whose completed output is the JSON our extractor returns.
const toolItem = (toolName, status, output) => ({
  info: { role: "assistant", id: "msg1" },
  parts: [
    {
      type: "tool",
      tool: toolName,
      state: { status, output },
    },
  ],
});

// A well-formed extractor output string with the given work-session end times.
const extractorOutput = (endMsList) =>
  JSON.stringify({
    params: { gap_minutes: 15, min_minutes: 15, since_ms: null },
    work_sessions: endMsList.map((endMs, index) => ({ index, end_ms: endMs })),
  });

describe("resolveCursorFromMessages", () => {
  test("no items -> null", () => {
    expect(resolveCursorFromMessages([])).toBeNull();
  });

  test("items without tool parts -> null", () => {
    const items = [
      { info: { role: "user", id: "u1" }, parts: [{ type: "text" }] },
    ];
    expect(resolveCursorFromMessages(items)).toBeNull();
  });

  test("one completed extract part -> max end_ms of its work-sessions", () => {
    const items = [
      toolItem("time_logger_extract_sessions", "completed", extractorOutput([1000, 5000, 3000])),
    ];
    expect(resolveCursorFromMessages(items)).toBe(5000);
  });

  test("multiple extract parts -> global max across all of them", () => {
    const items = [
      toolItem("time_logger_extract_sessions", "completed", extractorOutput([1000, 2000])),
      toolItem("time_logger_extract_sessions", "completed", extractorOutput([4000, 9000])),
      toolItem("time_logger_extract_sessions", "completed", extractorOutput([7000])),
    ];
    expect(resolveCursorFromMessages(items)).toBe(9000);
  });

  test("non-completed parts are ignored", () => {
    const items = [
      toolItem("time_logger_extract_sessions", "running", undefined),
      toolItem("time_logger_extract_sessions", "error", undefined),
      toolItem("time_logger_extract_sessions", "completed", extractorOutput([4242])),
    ];
    expect(resolveCursorFromMessages(items)).toBe(4242);
  });

  test("matches by output signature even when the tool name is namespaced", () => {
    const items = [
      toolItem("plugin.time_logger_extract_sessions", "completed", extractorOutput([8888])),
    ];
    expect(resolveCursorFromMessages(items)).toBe(8888);
  });

  test("malformed JSON output is skipped, not thrown", () => {
    const items = [
      toolItem("time_logger_extract_sessions", "completed", "{ not json"),
      toolItem("time_logger_extract_sessions", "completed", extractorOutput([321])),
    ];
    expect(resolveCursorFromMessages(items)).toBe(321);
  });

  test("tool output lacking our signature is ignored", () => {
    const items = [
      toolItem("some_other_tool", "completed", JSON.stringify({ result: "ok" })),
    ];
    expect(resolveCursorFromMessages(items)).toBeNull();
  });

  test("empty work_sessions contributes no cursor", () => {
    const items = [
      toolItem("time_logger_extract_sessions", "completed", extractorOutput([])),
    ];
    expect(resolveCursorFromMessages(items)).toBeNull();
  });
});
