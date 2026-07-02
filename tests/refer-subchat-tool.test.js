import { describe, expect, test } from "bun:test";
import { createReferSubchatTool } from "../.opencode/plugins/refer-subchat.js";

// A fake OpenCode client. `sessions` maps id -> { projectID, directory, parentID, title }.
// `messages` maps id -> session-messages items. Records temp-session lifecycle.
function fakeClient({ sessions = {}, messages = {}, providers = null, config = null } = {}) {
  const rec = { created: [], prompted: [], deleted: [], listed: 0 };
  let n = 0;
  return {
    rec,
    session: {
      get: async ({ path }) => {
        const s = sessions[path.id];
        return { data: s ? { id: path.id, ...s } : undefined };
      },
      list: async () => {
        rec.listed += 1;
        return {
          data: Object.entries(sessions).map(([id, s]) => ({ id, ...s })),
        };
      },
      messages: async ({ path }) => ({ data: messages[path.id] ?? [] }),
      create: async ({ body }) => {
        n += 1;
        const id = `tmp_${n}`;
        rec.created.push({ id, title: body?.title });
        return { data: { id, title: body?.title, projectID: "PROJ" } };
      },
      prompt: async ({ path, body }) => {
        rec.prompted.push({ id: path.id, body });
        return { data: { parts: [{ type: "text", text: "FAKE_SUMMARY" }] } };
      },
      delete: async ({ path }) => {
        rec.deleted.push(path.id);
        return { data: true };
      },
    },
    config: { get: async () => ({ data: config }) },
    provider: { list: async () => ({ data: providers }) },
  };
}

const textItems = (pairs) =>
  pairs.map(([role, text], i) => ({
    info: { role, id: `m${i}` },
    parts: [{ type: "text", text }],
  }));

const ctx = () => {
  const meta = [];
  return { c: { sessionID: "cur", metadata: (m) => meta.push(m) }, meta };
};

// Common project setup: current session "cur" lives in PROJ.
const baseSessions = {
  cur: { projectID: "PROJ", directory: "/proj" },
};

describe("refer_subchat tool", () => {
  test("listing mode: filters to current project, hides children", async () => {
    const client = fakeClient({
      sessions: {
        ...baseSessions,
        chatA: { projectID: "PROJ", directory: "/proj", title: "A", time: { updated: 3000 } },
        chatB: { projectID: "OTHER", directory: "/x", title: "B", time: { updated: 9000 } },
        childC: { projectID: "PROJ", directory: "/proj", title: "C", parentID: "chatA", time: { updated: 5000 } },
      },
    });
    const { refer_subchat } = createReferSubchatTool(client);
    const { c } = ctx();
    const out = JSON.parse(await refer_subchat.execute({}, c));
    expect(out.mode).toBe("listing");
    expect(out.project_id).toBe("PROJ");
    const ids = out.chats.map((e) => e.id);
    expect(ids).toContain("chatA");
    expect(ids).toContain("cur");
    expect(ids).not.toContain("chatB"); // other project
    expect(ids).not.toContain("childC"); // child session
  });

  test("cross-project session_id is rejected", async () => {
    const client = fakeClient({
      sessions: { ...baseSessions, evil: { projectID: "OTHER", directory: "/x" } },
    });
    const { refer_subchat } = createReferSubchatTool(client);
    const { c } = ctx();
    await expect(refer_subchat.execute({ session_id: "evil" }, c)).rejects.toThrow(
      /different project/,
    );
  });

  test("missing session_id target rejected", async () => {
    const client = fakeClient({ sessions: baseSessions });
    const { refer_subchat } = createReferSubchatTool(client);
    const { c } = ctx();
    await expect(refer_subchat.execute({ session_id: "ghost" }, c)).rejects.toThrow(
      /not found/,
    );
  });

  test("lines_only without keywords throws", async () => {
    const client = fakeClient({
      sessions: { ...baseSessions, t: { projectID: "PROJ", directory: "/proj" } },
    });
    const { refer_subchat } = createReferSubchatTool(client);
    const { c } = ctx();
    await expect(
      refer_subchat.execute({ session_id: "t", lines_only: true }, c),
    ).rejects.toThrow(/requires at least one keyword/);
  });

  test("lines_only returns windows, never summarizes (no temp session)", async () => {
    const client = fakeClient({
      sessions: { ...baseSessions, t: { projectID: "PROJ", directory: "/proj", title: "T" } },
      messages: {
        t: textItems([
          ["user", "line one"],
          ["assistant", "the CURSOR is here"],
          ["user", "line three"],
        ]),
      },
    });
    const { refer_subchat } = createReferSubchatTool(client);
    const { c } = ctx();
    const out = JSON.parse(
      await refer_subchat.execute(
        { session_id: "t", keywords: ["cursor"], lines_only: true },
        c,
      ),
    );
    expect(out.mode).toBe("lines_only");
    expect(out.window_count).toBe(1);
    expect(out.windows_text).toContain("CURSOR");
    expect(client.rec.created.length).toBe(0); // no summarization happened
  });

  test("grep sees FULL tool output (keyword past the 800-char summary cap)", async () => {
    // A tool part whose searched keyword sits well past the summary truncation
    // point (800). lines_only must still find it — grep uses the untruncated view.
    const needle = "SECRET_TOKEN_XYZ";
    const bigOutput = "a".repeat(1500) + " " + needle + " tail";
    const client = fakeClient({
      sessions: { ...baseSessions, t: { projectID: "PROJ", directory: "/proj", title: "T" } },
      messages: {
        t: [
          {
            info: { role: "assistant", id: "m0" },
            parts: [{ type: "tool", tool: "bash", state: { status: "completed", output: bigOutput } }],
          },
        ],
      },
    });
    const { refer_subchat } = createReferSubchatTool(client);
    const { c } = ctx();
    const out = JSON.parse(
      await refer_subchat.execute(
        { session_id: "t", keywords: [needle], lines_only: true },
        c,
      ),
    );
    expect(out.window_count).toBe(1);
    expect(out.windows_text).toContain(needle);
  });

  test("summary mode summarizes in temp session and cleans up", async () => {
    const client = fakeClient({
      sessions: { ...baseSessions, t: { projectID: "PROJ", directory: "/proj", title: "T" } },
      messages: { t: textItems([["user", "hello"], ["assistant", "world"]]) },
      config: { small_model: "anthropic/haiku" },
    });
    const { refer_subchat } = createReferSubchatTool(client);
    const { c } = ctx();
    const out = JSON.parse(await refer_subchat.execute({ session_id: "t" }, c));
    expect(out.mode).toBe("summary");
    expect(out.summary).toBe("FAKE_SUMMARY");
    expect(out.summary_model).toBe("anthropic/haiku");
    expect(client.rec.created.length).toBe(1);
    expect(client.rec.deleted.length).toBe(1);
    // model forwarded, tools disabled
    expect(client.rec.prompted[0].body.model).toEqual({ providerID: "anthropic", modelID: "haiku" });
    expect(client.rec.prompted[0].body.tools).toEqual({});
  });

  test("summary mode + keywords also returns windows", async () => {
    const client = fakeClient({
      sessions: { ...baseSessions, t: { projectID: "PROJ", directory: "/proj", title: "T" } },
      messages: {
        t: textItems([["user", "about the CURSOR feature"], ["assistant", "ok"]]),
      },
    });
    const { refer_subchat } = createReferSubchatTool(client);
    const { c } = ctx();
    const out = JSON.parse(
      await refer_subchat.execute({ session_id: "t", keywords: ["cursor"] }, c),
    );
    expect(out.mode).toBe("summary");
    expect(out.window_count).toBe(1);
    expect(out.windows_text).toContain("CURSOR");
    // focus hint carries the keywords into the summarizer prompt
    expect(client.rec.prompted[0].body.parts[0].text).toContain("cursor");
  });
});
