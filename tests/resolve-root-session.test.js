import { describe, expect, test } from "bun:test";
import { resolveRootSessionId } from "../src/resolve-root-session.js";

// Build a stub client whose session.get returns canned responses per id.
// `sessions` is a Map<id, { id, parentID? }> — missing id throws by default.
function makeClient(sessions, opts = {}) {
  return {
    session: {
      get: async ({ path: { id } }) => {
        if (opts.throwOn?.includes(id)) {
          throw new Error(`simulated fetch error for ${id}`);
        }
        if (!sessions.has(id)) {
          throw new Error(`session not found: ${id}`);
        }
        return { data: sessions.get(id) };
      },
    },
  };
}

describe("resolveRootSessionId", () => {
  test("returns same id when session has no parentID (root case)", async () => {
    const client = makeClient(new Map([["ses_root", { id: "ses_root" }]]));
    const result = await resolveRootSessionId(client, "ses_root");
    expect(result).toBe("ses_root");
  });

  test("walks one level: child -> parent root", async () => {
    const sessions = new Map([
      ["ses_child", { id: "ses_child", parentID: "ses_root" }],
      ["ses_root", { id: "ses_root" }],
    ]);
    const client = makeClient(sessions);
    const result = await resolveRootSessionId(client, "ses_child");
    expect(result).toBe("ses_root");
  });

  test("walks multiple levels: grandchild -> child -> root", async () => {
    const sessions = new Map([
      ["ses_grand", { id: "ses_grand", parentID: "ses_child" }],
      ["ses_child", { id: "ses_child", parentID: "ses_root" }],
      ["ses_root", { id: "ses_root" }],
    ]);
    const client = makeClient(sessions);
    const result = await resolveRootSessionId(client, "ses_grand");
    expect(result).toBe("ses_root");
  });

  test("stops at hop cap and returns last good id (cycle guard)", async () => {
    // A <-> B cycle: would loop forever without the cap.
    const sessions = new Map([
      ["ses_a", { id: "ses_a", parentID: "ses_b" }],
      ["ses_b", { id: "ses_b", parentID: "ses_a" }],
    ]);
    const client = makeClient(sessions);
    // With maxHops=4 it should stop after 4 hops and return whatever it last saw.
    const result = await resolveRootSessionId(client, "ses_a", 4);
    // Should be one of the two known ids, not throw and not infinite-loop.
    expect(["ses_a", "ses_b"]).toContain(result);
  });

  test("falls back to last good id when an intermediate fetch throws", async () => {
    // Chain: grandchild -> child -> root, but root fetch blows up.
    const sessions = new Map([
      ["ses_grand", { id: "ses_grand", parentID: "ses_child" }],
      ["ses_child", { id: "ses_child", parentID: "ses_root" }],
    ]);
    const client = makeClient(sessions, { throwOn: ["ses_root"] });
    // Last successfully fetched id before the failure was ses_child.
    const result = await resolveRootSessionId(client, "ses_grand");
    expect(result).toBe("ses_child");
  });

  test("throws a clear error when the very first fetch fails", async () => {
    const client = makeClient(new Map(), { throwOn: ["ses_missing"] });
    await expect(
      resolveRootSessionId(client, "ses_missing"),
    ).rejects.toThrow(/resolveRootSessionId: failed to fetch session "ses_missing"/);
  });
});
