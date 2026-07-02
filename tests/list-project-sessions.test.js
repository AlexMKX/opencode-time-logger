import { describe, expect, test } from "bun:test";
import { listProjectSessions } from "../src/list-project-sessions.js";
import { TEMP_TITLE_PREFIX } from "../src/summarize-transcript.js";

const s = (id, projectID, extra = {}) => ({
  id,
  projectID,
  title: extra.title ?? id,
  parentID: extra.parentID,
  time: { created: extra.created ?? 1000, updated: extra.updated ?? extra.created ?? 1000 },
});

describe("listProjectSessions", () => {
  test("empty / missing project -> []", () => {
    expect(listProjectSessions([], "p")).toEqual([]);
    expect(listProjectSessions([s("a", "p")], "")).toEqual([]);
    expect(listProjectSessions(null, "p")).toEqual([]);
  });

  test("keeps only current-project sessions", () => {
    const out = listProjectSessions(
      [s("a", "p1"), s("b", "p2"), s("c", "p1")],
      "p1",
    );
    expect(out.map((e) => e.id).sort()).toEqual(["a", "c"]);
  });

  test("hides temp summarization sessions by title prefix", () => {
    const out = listProjectSessions(
      [s("real", "p"), s("tmp", "p", { title: `${TEMP_TITLE_PREFIX} whatever` })],
      "p",
    );
    expect(out.map((e) => e.id)).toEqual(["real"]);
  });

  test("drops child sessions by default, keeps with includeChildren", () => {
    const list = [s("root", "p"), s("child", "p", { parentID: "root" })];
    expect(listProjectSessions(list, "p").map((e) => e.id)).toEqual(["root"]);
    const withKids = listProjectSessions(list, "p", { includeChildren: true });
    expect(withKids.map((e) => e.id).sort()).toEqual(["child", "root"]);
    expect(withKids.find((e) => e.id === "child").parent_id).toBe("root");
  });

  test("sorts by updated desc and emits iso", () => {
    const out = listProjectSessions(
      [
        s("old", "p", { updated: 1000 }),
        s("new", "p", { updated: 5000 }),
        s("mid", "p", { updated: 3000 }),
      ],
      "p",
    );
    expect(out.map((e) => e.id)).toEqual(["new", "mid", "old"]);
    expect(typeof out[0].updated_iso).toBe("string");
  });

  test("falls back to created when updated missing", () => {
    const out = listProjectSessions(
      [{ id: "x", projectID: "p", title: "x", time: { created: 2222 } }],
      "p",
    );
    expect(out[0].updated_ms).toBe(2222);
  });
});
