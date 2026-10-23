import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toV1Items } from "../src/v2/adapt-messages.js";
import { createShimClient, toV1Providers, toV1Session } from "../src/v2/shim-client.js";
import { loadSkills, parseSkillFile } from "../src/v2/skills.js";
import {
  createTimelineRecorder,
  mergeTimeline,
  timelineEntryFromEvent,
  timelineKey,
} from "../src/v2/timeline.js";
import { executeExtract } from "../src/extract-core.js";
import plugin from "../index.js";

// Shapes below are trimmed from payloads captured off OpenCode 2.1.3.
const v2Messages = [
  { type: "compaction", id: "c1", time: { created: 900 }, status: "completed", reason: "manual", summary: "did X" },
  { type: "idle", id: "i1", time: { created: 950 }, outcome: "succeeded" },
  { type: "user", id: "u1", time: { created: 1000 }, text: "hello", files: [] },
  {
    type: "assistant",
    id: "a1",
    time: { created: 1100, completed: 1200 },
    agent: "build",
    model: { id: "m", providerID: "p" },
    content: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "hi" },
      {
        type: "tool",
        id: "call1",
        name: "shell",
        state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "a.txt" }] },
        time: { created: 1150 },
      },
    ],
  },
  { type: "synthetic", id: "s1", time: { created: 1300 }, text: "note" },
];

describe("toV1Items", () => {
  test("maps user/assistant, drops reasoning, idle, synthetic", () => {
    const items = toV1Items(v2Messages);
    expect(items.map((i) => i.info.id)).toEqual(["u1", "a1"]);
    expect(items[0]).toEqual({
      info: { id: "u1", role: "user", time: { created: 1000 } },
      parts: [{ type: "text", text: "hello" }],
    });
    expect(items[1].parts).toEqual([
      { type: "text", text: "hi" },
      { type: "tool", tool: "shell", state: { status: "completed", input: { command: "ls" }, output: "a.txt" } },
    ]);
  });

  test("compaction summary kept only on request", () => {
    const items = toV1Items(v2Messages, { compaction: true });
    expect(items[0].info).toEqual({ id: "c1", role: "assistant", time: { created: 900 } });
    expect(items[0].parts[0].text).toContain("did X");
  });

  test("non-array input -> []", () => {
    expect(toV1Items(undefined)).toEqual([]);
  });
});

describe("timeline", () => {
  const enqueued = {
    type: "session.inbox.enqueued",
    created: 1000,
    data: { sessionID: "S", inboxID: "u1", item: { type: "user", payload: { text: "x" } } },
  };
  const step = {
    type: "session.step.started",
    created: 1105,
    data: { sessionID: "S", assistantMessageID: "a1", started: 1100 },
  };

  test("timelineEntryFromEvent maps user prompts and assistant steps", () => {
    expect(timelineEntryFromEvent(enqueued)).toEqual({ sessionID: "S", id: "u1", role: "user", timeMs: 1000 });
    expect(timelineEntryFromEvent(step)).toEqual({ sessionID: "S", id: "a1", role: "assistant", timeMs: 1100 });
    const synthetic = { ...enqueued, data: { ...enqueued.data, item: { type: "synthetic" } } };
    expect(timelineEntryFromEvent(synthetic)).toBeNull();
    expect(timelineEntryFromEvent({ type: "session.text.delta", data: { sessionID: "S" } })).toBeNull();
  });

  test("mergeTimeline adds missing entries, live items win, sorted by time", () => {
    const live = toV1Items(v2Messages);
    const merged = mergeTimeline(
      [
        ["old", "u", 10],
        ["u1", "u", 999999],
        ["older-a", "a", 20],
      ],
      live,
    );
    expect(merged.map((i) => i.info.id)).toEqual(["old", "older-a", "u1", "a1"]);
    expect(merged[2].info.time.created).toBe(1000);
    expect(merged[0].parts).toEqual([]);
  });

  test("recorder batches, dedupes, skips child sessions", async () => {
    const store = new Map();
    const storage = { get: async (k) => store.get(k), set: async (k, v) => store.set(k, v) };
    const rec = createTimelineRecorder(storage, { flushMs: 60_000 });
    rec.observe(enqueued);
    rec.observe(step);
    rec.observe(step);
    rec.observe({ type: "session.created", data: { sessionID: "C", parentID: "S" } });
    rec.observe({ ...step, data: { ...step.data, sessionID: "C" } });
    expect(await rec.load("S")).toEqual([
      ["u1", "u", 1000],
      ["a1", "a", 1100],
    ]);
    expect(store.has(timelineKey("C"))).toBe(false);
  });
});

describe("shim client", () => {
  test("toV1Session lifts location.directory", () => {
    expect(toV1Session({ id: "S", location: { directory: "/p" } }).directory).toBe("/p");
  });

  test("toV1Providers groups models and keeps resolveSummaryModel fields", () => {
    const out = toV1Providers([
      {
        id: "haiku",
        providerID: "anthropic",
        name: "Haiku",
        status: "active",
        enabled: true,
        cost: [{ input: 1, output: 5 }],
        capabilities: { output: ["text"] },
      },
      { id: "off", providerID: "anthropic", name: "Off", enabled: false, cost: [] },
    ]);
    expect(out.connected).toEqual([]);
    expect(out.all[0].id).toBe("anthropic");
    expect(out.all[0].models.haiku).toEqual({
      id: "haiku",
      name: "Haiku",
      status: "active",
      cost: { input: 1, output: 5 },
      modalities: { output: ["text"] },
    });
    expect(out.all[0].models.off.status).toBe("disabled");
  });

  test("extract core runs on the shim and merges the stored timeline", async () => {
    const ctx = {
      session: {
        get: async ({ sessionID }) =>
          sessionID === "child"
            ? { id: "child", parentID: "root", location: { directory: "/p" } }
            : { id: "root", title: "T", location: { directory: "/p" } },
        context: async () => v2Messages,
      },
    };
    const client = createShimClient(ctx, {
      augmentItems: async (_id, items) => mergeTimeline([["early", "u", 50]], items),
    });
    let saved;
    const out = JSON.parse(
      await executeExtract(client, {}, { sessionID: "child" }, {
        readCursor: async () => null,
        onExtracted: (id, r) => {
          saved = [id, r.work_sessions.length];
        },
      }),
    );
    expect(out.session_id).toBe("root");
    expect(out.directory).toBe("/p");
    expect(out.work_sessions[0].user_message_count).toBe(2);
    expect(saved).toEqual(["root", 1]);
  });
});

describe("skills", () => {
  test("parseSkillFile handles quoted and block descriptions", () => {
    expect(parseSkillFile('---\nname: a\ndescription: "say \\"hi\\""\n---\nBody').fields).toEqual({
      name: "a",
      description: 'say "hi"',
    });
    const block = parseSkillFile("---\nname: b\ndescription: >\n  one\n  two\n---\n\nBody\n");
    expect(block.fields.description).toBe("one two");
    expect(block.body).toBe("\nBody\n");
  });

  test("loadSkills reads the bundled skills", () => {
    const root = path.resolve(import.meta.dir, "..");
    const skills = loadSkills([path.join(root, "skills"), path.join(root, "packages/refer-subchat/skills")]);
    expect(skills.map((s) => s.id).sort()).toEqual(["jira-time-tracker", "refer-subchat"]);
    for (const s of skills) {
      expect(path.isAbsolute(s.path)).toBe(true);
      expect(s.description?.length).toBeGreaterThan(0);
      expect(s.content.startsWith("---")).toBe(false);
    }
  });

  test("loadSkills skips missing dirs and falls back to folder name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-skills-"));
    fs.mkdirSync(path.join(dir, "plain"));
    fs.writeFileSync(path.join(dir, "plain", "SKILL.md"), "no frontmatter");
    expect(loadSkills([path.join(dir, "missing"), dir])).toEqual([
      { id: "plain", name: "plain", path: path.join(dir, "plain", "SKILL.md"), content: "no frontmatter" },
    ]);
  });
});

describe("V2 entry", () => {
  test("index.js default-exports one object for both generations", () => {
    expect(plugin.id).toBe("opencode-time-logger");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
  });
});
