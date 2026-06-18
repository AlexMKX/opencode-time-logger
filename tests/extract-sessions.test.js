import { describe, expect, test } from "bun:test";
import {
  extractWorkSessions,
  toJiraDateTime,
  toJiraTimeSpent,
} from "../src/extract-sessions.js";

// All test timestamps use a fixed base so behavior is deterministic regardless
// of the host timezone. We avoid asserting on time-zone-dependent string output
// (e.g. startIso/startJira) — the algorithm-level assertions only look at
// numeric fields (startMs, billedMinutes, etc).
const T0 = 1781700000000; // arbitrary epoch ms

const min = (n) => n * 60 * 1000;

function mkMsg(offsetMin, role, id) {
  return { timeMs: T0 + min(offsetMin), role, id };
}

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

  test("gap > 10 min between user/assistant splits sessions", () => {
    const result = extractWorkSessions([
      mkMsg(0, "user", "u1"),
      mkMsg(5, "assistant", "a1"),
      mkMsg(20, "user", "u2"), // 15-min gap from a1
      mkMsg(25, "assistant", "a2"),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].startMs).toBe(T0);
    expect(result[0].endMs).toBe(T0 + min(5));
    expect(result[1].startMs).toBe(T0 + min(20));
  });

  test("gap > 10 min between two assistant messages also splits (resume-after-sleep)", () => {
    // Reproduces the bug from the v1 algorithm: 11h between assistant msgs but
    // no user msg in between — must still split.
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

  test("rounding up: 16min raw -> 30m billed (ceil to 15)", () => {
    // Chain of close-spaced assistant msgs lets the session grow past 15min
    // without crossing the 10-min gap threshold.
    const result = extractWorkSessions([
      mkMsg(0, "user", "u1"),
      mkMsg(8, "assistant", "a1"),
      mkMsg(16, "assistant", "a2"),
    ]);
    expect(result[0].rawMinutes).toBe(16);
    expect(result[0].billedMinutes).toBe(30);
    expect(result[0].jiraTimeSpent).toBe("30m");
  });

  test("rounding up: 61min raw -> 75m (1h 15m) billed", () => {
    const result = extractWorkSessions([
      mkMsg(0, "user", "u1"),
      mkMsg(8, "assistant", "a1"),
      mkMsg(16, "assistant", "a2"),
      mkMsg(24, "assistant", "a3"),
      mkMsg(32, "assistant", "a4"),
      mkMsg(40, "assistant", "a5"),
      mkMsg(48, "assistant", "a6"),
      mkMsg(56, "assistant", "a7"),
      mkMsg(61, "assistant", "a8"),
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
        mkMsg(30, "user", "u2"),
        mkMsg(35, "assistant", "a2"),
      ],
      { sinceMs: T0 + min(20) },
    );
    expect(result).toHaveLength(1);
    expect(result[0].startMs).toBe(T0 + min(30));
    // index is re-numbered from 0 after filtering
    expect(result[0].index).toBe(0);
  });

  test("custom gapMinutes is respected", () => {
    const result = extractWorkSessions(
      [
        mkMsg(0, "user", "u1"),
        mkMsg(3, "assistant", "a1"),
        mkMsg(7, "user", "u2"), // 4-min gap — would merge with default 10, but split with 3
      ],
      { gapMinutes: 3 },
    );
    expect(result).toHaveLength(2);
  });

  test("unsorted input is sorted before processing", () => {
    const result = extractWorkSessions([
      mkMsg(20, "user", "u2"),
      mkMsg(0, "user", "u1"),
      mkMsg(5, "assistant", "a1"),
      mkMsg(25, "assistant", "a2"),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].startMs).toBe(T0);
    expect(result[1].startMs).toBe(T0 + min(20));
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
    // Pattern: yyyy-MM-ddTHH:mm:ss.SSS[+-]HHMM
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
