import { describe, expect, test } from "bun:test";
import {
  summarizeTranscript,
  TEMP_TITLE_PREFIX,
} from "../src/summarize-transcript.js";

// Fake SDK client that records lifecycle calls and echoes a canned reply.
function fakeClient({ reply = "SUMMARY", failDelete = false } = {}) {
  const calls = { create: 0, prompt: [], delete: [] };
  let n = 0;
  return {
    calls,
    session: {
      create: async ({ body }) => {
        calls.create += 1;
        n += 1;
        return { data: { id: `tmp_${n}`, title: body?.title } };
      },
      prompt: async ({ path, body }) => {
        calls.prompt.push({ id: path.id, body });
        return { data: { parts: [{ type: "text", text: reply }] } };
      },
      delete: async ({ path }) => {
        calls.delete.push(path.id);
        if (failDelete) throw new Error("delete boom");
        return { data: true };
      },
    },
  };
}

describe("summarizeTranscript", () => {
  test("empty text -> no session, explicit message", async () => {
    const client = fakeClient();
    const out = await summarizeTranscript(client, { text: "   ", directory: "/p" });
    expect(out.passes).toBe(0);
    expect(client.calls.create).toBe(0);
    expect(out.summary).toContain("empty transcript");
  });

  test("single pass for small text, temp session created and deleted", async () => {
    const client = fakeClient({ reply: "S1" });
    const out = await summarizeTranscript(client, {
      text: "short transcript",
      directory: "/p",
    });
    expect(out).toMatchObject({ summary: "S1", passes: 1, chunks: 1 });
    expect(client.calls.create).toBe(1);
    expect(client.calls.delete).toEqual(["tmp_1"]);
  });

  test("temp session title is prefixed for discovery filtering", async () => {
    const titles = [];
    const client = fakeClient();
    const orig = client.session.create;
    client.session.create = async (arg) => {
      titles.push(arg.body.title);
      return orig(arg);
    };
    await summarizeTranscript(client, { text: "x", directory: "/p" });
    expect(titles[0]).toBe(TEMP_TITLE_PREFIX);
  });

  test("tools disabled and model forwarded on every prompt", async () => {
    const client = fakeClient();
    await summarizeTranscript(client, {
      text: "hello",
      directory: "/p",
      model: { providerID: "anthropic", modelID: "haiku" },
    });
    for (const p of client.calls.prompt) {
      expect(p.body.tools).toEqual({});
      expect(p.body.model).toEqual({ providerID: "anthropic", modelID: "haiku" });
      expect(typeof p.body.system).toBe("string");
    }
  });

  test("map-reduce: large text -> chunk summaries + a reduce pass", async () => {
    // 5 lines each ~40 chars; maxChars 60 forces multiple chunks.
    const text = Array.from({ length: 5 }, (_, i) => "x".repeat(40) + i).join("\n");
    const client = fakeClient({ reply: "P" });
    const out = await summarizeTranscript(client, {
      text,
      directory: "/p",
      maxChars: 60,
    });
    expect(out.chunks).toBeGreaterThan(1);
    // at least one prompt per chunk (map) plus a final reduce; reduce may
    // recurse when the concatenated partials are themselves over budget.
    expect(out.passes).toBeGreaterThanOrEqual(out.chunks + 1);
    expect(client.calls.create).toBe(client.calls.prompt.length);
    // every created session was deleted
    expect(client.calls.delete.length).toBe(client.calls.create);
  });

  test("focus hint injected into the prompt text", async () => {
    const client = fakeClient();
    await summarizeTranscript(client, {
      text: "body",
      directory: "/p",
      focus: "cursor, projectID",
    });
    const sent = client.calls.prompt[0].body.parts[0].text;
    expect(sent).toContain("cursor, projectID");
  });

  test("delete failure does not break summarization", async () => {
    const client = fakeClient({ reply: "OK", failDelete: true });
    const out = await summarizeTranscript(client, { text: "x", directory: "/p" });
    expect(out.summary).toBe("OK");
    expect(client.calls.delete).toEqual(["tmp_1"]);
  });

  // A client whose prompt never resolves — simulates a stalled model stream.
  function hangingClient() {
    const calls = { aborted: [], deleted: [] };
    let n = 0;
    return {
      calls,
      session: {
        create: async () => ({ data: { id: `tmp_${++n}` } }),
        prompt: () => new Promise(() => {}), // never settles
        abort: async ({ path }) => { calls.aborted.push(path.id); return { data: true }; },
        delete: async ({ path }) => { calls.deleted.push(path.id); return { data: true }; },
      },
    };
  }

  test("single stalled pass times out, aborts + deletes temp, degrades", async () => {
    const client = hangingClient();
    const out = await summarizeTranscript(client, {
      text: "short",
      directory: "/p",
      passTimeoutMs: 30,
    });
    expect(out.timedOut).toBe(1);
    expect(out.summary).toContain("timed out");
    expect(client.calls.aborted).toEqual(["tmp_1"]); // stream stopped server-side
    expect(client.calls.deleted).toEqual(["tmp_1"]); // temp cleaned up
  });

  test("map-reduce: a stalled chunk is skipped, others still summarized", async () => {
    // First prompt hangs, the rest reply — verify one timeout doesn't sink all.
    const calls = { deleted: [], aborted: [] };
    let n = 0;
    const client = {
      calls,
      session: {
        create: async () => ({ data: { id: `tmp_${++n}` } }),
        prompt: ({ path }) =>
          path.id === "tmp_1"
            ? new Promise(() => {})
            : Promise.resolve({ data: { parts: [{ type: "text", text: "P" }] } }),
        abort: async ({ path }) => { calls.aborted.push(path.id); return { data: true }; },
        delete: async ({ path }) => { calls.deleted.push(path.id); return { data: true }; },
      },
    };
    const text = Array.from({ length: 5 }, (_, i) => "x".repeat(40) + i).join("\n");
    const out = await summarizeTranscript(client, {
      text,
      directory: "/p",
      maxChars: 60,
      passTimeoutMs: 30,
    });
    expect(out.timedOut).toBeGreaterThanOrEqual(1);
    expect(client.calls.aborted).toContain("tmp_1");
    // still produced a summary from the surviving chunks
    expect(typeof out.summary).toBe("string");
    expect(out.summary.length).toBeGreaterThan(0);
  });

  test("external abort during a pass stops summarization + aborts temp", async () => {
    const client = hangingClient();
    const ac = new AbortController();
    // Abort after the temp session is created and the prompt is hanging.
    setTimeout(() => ac.abort(), 15);
    const out = await summarizeTranscript(client, {
      text: "short",
      directory: "/p",
      passTimeoutMs: 60000,
      signal: ac.signal,
    });
    expect(out.timedOut).toBe(1);
    expect(client.calls.aborted).toEqual(["tmp_1"]);
  });

  test("abort before any work does not hang and creates nothing to abort", async () => {
    const client = hangingClient();
    const ac = new AbortController();
    ac.abort(); // already aborted
    const out = await summarizeTranscript(client, {
      text: "short",
      directory: "/p",
      passTimeoutMs: 60000,
      signal: ac.signal,
    });
    expect(out.timedOut).toBe(1);
    expect(client.calls.aborted).toEqual([]); // never created a temp session
  });
});
