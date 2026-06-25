/**
 * Schema validation tests for time_logger_extract_sessions args.
 *
 * Approach B: argsSchema is exported from src/tool-args-schema.js (a pure zod
 * module with no OpenCode runtime dependencies), so these tests run without
 * any plugin runtime setup.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { argsSchema, argsZ } from "../src/tool-args-schema.js";

// Sanity: argsSchema is a plain object; argsZ is the wrapped z.object.
const schema = argsZ;

describe("argsSchema — session_id", () => {
  test("empty object is valid (both args are optional)", () => {
    expect(schema.safeParse({}).success).toBe(true);
  });

  test("valid ses_abc123 passes", () => {
    expect(schema.safeParse({ session_id: "ses_abc123" }).success).toBe(true);
  });

  test("empty string is rejected", () => {
    expect(schema.safeParse({ session_id: "" }).success).toBe(false);
  });

  test("arbitrary garbage string is rejected (no ses_ prefix)", () => {
    expect(schema.safeParse({ session_id: "garbage" }).success).toBe(false);
  });

  test("whitespace-only string is rejected (trim leaves empty, regex fails)", () => {
    expect(schema.safeParse({ session_id: "   " }).success).toBe(false);
  });
});

describe("argsSchema — since_ms", () => {
  test("since_ms: 0 is rejected (must be positive)", () => {
    expect(schema.safeParse({ since_ms: 0 }).success).toBe(false);
  });

  test("since_ms: -1 is rejected (must be positive)", () => {
    expect(schema.safeParse({ since_ms: -1 }).success).toBe(false);
  });

  test("since_ms: realistic epoch-ms passes", () => {
    expect(schema.safeParse({ since_ms: 1782372673964 }).success).toBe(true);
  });

  test("since_ms omitted (undefined) is fine — optional", () => {
    expect(schema.safeParse({}).success).toBe(true);
  });
});

describe("argsSchema — both fields together", () => {
  test("both valid args pass", () => {
    expect(
      schema.safeParse({
        session_id: "ses_XYZ789",
        since_ms: 1782372673964,
      }).success,
    ).toBe(true);
  });

  test("argsSchema export is a plain object (not a ZodObject)", () => {
    // Ensure the schema file exports a raw field map, not a pre-wrapped ZodObject,
    // so the plugin can pass it directly to tool({ args: argsSchema }).
    expect(typeof argsSchema).toBe("object");
    expect(argsSchema).not.toBeInstanceOf(z.ZodObject);
  });
});
