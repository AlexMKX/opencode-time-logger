import { describe, expect, test } from "bun:test";
import {
  extractWorkSessions,
  toJiraDateTime,
  toJiraTimeSpent,
  GAP_MINUTES,
  MIN_MINUTES,
} from "../src/extract-sessions.js";

// Fixed base so behavior is deterministic regardless of host timezone.
// Assertions intentionally avoid timezone-dependent string output.
const T0 = 1781700000000;
const min = (n) => n * 60 * 1000;
const mkMsg = (offsetMin, role, id) => ({
  timeMs: T0 + min(offsetMin),
  role,
  id,
});

describe("constants", () => {
  test("gap and min are both 15 (hard-coded by design)", () => {
    expect(GAP_MINUTES).toBe(15);
    expect(MIN_MINUTES).toBe(15);
  });
});

describe("extractWorkSessions", () => {
  test("empty input -> no sessions", () => {
    expect(extractWorkSessions([])).toEqual([]);
  });

  test("orphan assistant messages without a user start are dropped", () => {
    const result = extractWorkSessions([
      mkMsg(0, "assistant", "a1"),
      mkMsg(1, "assistant", "a2"),
    ]);
    expect(result).toEqual([]);
  });

  test("single user message produces one min-clamped session", () => {
    const result = extractWorkSessions([mkMsg(0, "user", "u1")]);
    expect(result).toHaveLength(1);
    expect(result[0].userMessageCount).toBe(1);
    expect(result[0].assistantMessageCount).toBe(0);
    expect(result[0].rawMinutes).toBe(0);
    expect(result[0].billedMinutes).toBe(15);
    expect(result[0].jiraTimeSpent).toBe("15m");
    expect(result[0].firstUserMsgId).toBe("u1");
  });

  test("gap > 15 min splits sessions", () => {
    const result = extractWorkSessions([
      mkMsg(0, "user", "u1"),
      mkMsg(5, "assistant", "a1"),
      mkMsg(25, "user", "u2"), // 20-min gap from a1 -> new session
      mkMsg(30, "assistant", "a2"),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].startMs).toBe(T0);
    expect(result[0].endMs).toBe(T0 + min(5));
    expect(result[1].startMs).toBe(T0 + min(25));
  });

  test("gap exactly 15 min does NOT split (boundary)", () => {
    const result = extractWorkSessions([
      mkMsg(0, "user", "u1"),
      mkMsg(15, "assistant", "a1"), // 15-min gap, not > 15
    ]);
    expect(result).toHaveLength(1);
  });

  test("overnight gap between two assistant messages still splits (resume-after-sleep)", () => {
    const result = extractWorkSessions([
      mkMsg(0, "user", "u1"),
      mkMsg(2, "assistant", "a1"),
      mkMsg(2 + 11 * 60, "assistant", "a2"), // 11h gap
      mkMsg(2 + 11 * 60 + 1, "user", "u2"),
      mkMsg(2 + 11 * 60 + 5, "assistant", "a3"),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].endMs).toBe(T0 + min(2));
    expect(result[1].startMs).toBe(T0 + min(2 + 11 * 60 + 1));
  });

  test("minimum-duration clamp: <15min raw -> 15m billed", () => {
    const result = extractWorkSessions([
      mkMsg(0, "user", "u1"),
      mkMsg(3, "assistant", "a1"),
    ]);
    expect(result[0].rawMinutes).toBe(3);
    expect(result[0].billedMinutes).toBe(15);
    expect(result[0].jiraTimeSpent).toBe("15m");
  });

  test("rounding up: 16min raw -> 30m billed", () => {
    // Chain of close-spaced msgs stays within the 15-min gap threshold.
    const result = extractWorkSessions([
      mkMsg(0, "user", "u1"),
      mkMsg(10, "assistant", "a1"),
      mkMsg(16, "assistant", "a2"),
    ]);
    expect(result[0].rawMinutes).toBe(16);
    expect(result[0].billedMinutes).toBe(30);
    expect(result[0].jiraTimeSpent).toBe("30m");
  });

  test("rounding up: 61min raw -> 75m (1h 15m)", () => {
    const result = extractWorkSessions([
      mkMsg(0, "user", "u1"),
      mkMsg(12, "assistant", "a1"),
      mkMsg(24, "assistant", "a2"),
      mkMsg(36, "assistant", "a3"),
      mkMsg(48, "assistant", "a4"),
      mkMsg(61, "assistant", "a5"),
    ]);
    expect(result[0].rawMinutes).toBe(61);
    expect(result[0].billedMinutes).toBe(75);
    expect(result[0].jiraTimeSpent).toBe("1h 15m");
  });

  test("sinceMs filter drops earlier sessions", () => {
    const result = extractWorkSessions(
      [
        mkMsg(0, "user", "u1"),
        mkMsg(5, "assistant", "a1"),
        mkMsg(40, "user", "u2"), // 35-min gap from a1 -> new session
        mkMsg(45, "assistant", "a2"),
      ],
      T0 + min(20),
    );
    expect(result).toHaveLength(1);
    expect(result[0].startMs).toBe(T0 + min(40));
    // index is re-numbered after filtering
    expect(result[0].index).toBe(0);
  });

  test("undefined sinceMs is treated as 'no cutoff' (regression: NaN bug)", () => {
    // The prod bug: zod's `.optional()` produced explicit-undefined args that
    // the old options-spread plumbing then turned into NaN multipliers, which
    // cascaded into billed_minutes: null / jira_time_spent: "NaNm".
    const result = extractWorkSessions(
      [mkMsg(0, "user", "u1"), mkMsg(5, "assistant", "a1")],
      undefined,
    );
    expect(result).toHaveLength(1);
    expect(result[0].billedMinutes).toBe(15);
    expect(result[0].jiraTimeSpent).toBe("15m");
    expect(Number.isNaN(result[0].billedMinutes)).toBe(false);
  });

  test("garbage sinceMs falls back to no-cutoff", () => {
    const result = extractWorkSessions(
      [mkMsg(0, "user", "u1"), mkMsg(5, "assistant", "a1")],
      /** @type {any} */ (NaN),
    );
    expect(result).toHaveLength(1);
    expect(result[0].billedMinutes).toBe(15);
  });

  test("unsorted input is sorted before processing", () => {
    const result = extractWorkSessions([
      mkMsg(40, "user", "u2"),
      mkMsg(0, "user", "u1"),
      mkMsg(5, "assistant", "a1"),
      mkMsg(45, "assistant", "a2"),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].startMs).toBe(T0);
    expect(result[1].startMs).toBe(T0 + min(40));
  });

  test("invalid roles are filtered out", () => {
    const result = extractWorkSessions([
      mkMsg(0, "user", "u1"),
      { timeMs: T0 + min(2), role: "system", id: "s1" },
      mkMsg(5, "assistant", "a1"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].userMessageCount).toBe(1);
    expect(result[0].assistantMessageCount).toBe(1);
  });
});

describe("toJiraDateTime", () => {
  test("includes milliseconds and offset without colon", () => {
    const s = toJiraDateTime(T0);
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/);
    expect(s).not.toContain(".000+03:00"); // offset must NOT have a colon
  });
});

describe("toJiraTimeSpent", () => {
  test("minutes only", () => {
    expect(toJiraTimeSpent(15)).toBe("15m");
    expect(toJiraTimeSpent(45)).toBe("45m");
  });
  test("hours only", () => {
    expect(toJiraTimeSpent(60)).toBe("1h");
    expect(toJiraTimeSpent(120)).toBe("2h");
  });
  test("hours and minutes", () => {
    expect(toJiraTimeSpent(75)).toBe("1h 15m");
    expect(toJiraTimeSpent(135)).toBe("2h 15m");
  });
});
