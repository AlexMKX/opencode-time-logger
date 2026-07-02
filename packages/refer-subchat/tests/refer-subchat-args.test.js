import { describe, expect, test } from "bun:test";
import { argsZ } from "../src/args.js";

describe("refer_subchat args schema", () => {
  test("all fields optional -> empty object valid (listing mode)", () => {
    const r = argsZ.safeParse({});
    expect(r.success).toBe(true);
  });

  test("accepts session_id + keywords + lines_only", () => {
    const r = argsZ.safeParse({
      session_id: "ses_abc",
      keywords: ["cursor", "projectID"],
      lines_only: true,
    });
    expect(r.success).toBe(true);
  });

  test("rejects empty session_id", () => {
    expect(argsZ.safeParse({ session_id: "" }).success).toBe(false);
  });

  test("rejects empty keyword strings", () => {
    expect(argsZ.safeParse({ keywords: [""] }).success).toBe(false);
  });

  test("rejects wrong types", () => {
    expect(argsZ.safeParse({ keywords: "not-array" }).success).toBe(false);
    expect(argsZ.safeParse({ lines_only: "yes" }).success).toBe(false);
    expect(argsZ.safeParse({ session_id: 123 }).success).toBe(false);
  });
});
