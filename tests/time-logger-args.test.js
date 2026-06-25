/**
 * Schema validation tests for time_logger_extract_sessions args.
 *
 * Approach B: argsSchema is exported from src/tool-args-schema.js (a pure zod
 * module with no OpenCode runtime dependencies), so these tests run without
 * any plugin runtime setup.
 *
 * session_id is intentionally not tested — it was removed from the schema.
 * The tool now always infers the session from ctx.sessionID.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { argsSchema, argsZ } from "../src/tool-args-schema.js";

// Sanity: argsSchema is a plain object; argsZ is the wrapped z.object.
const schema = argsZ;

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

describe("argsSchema — structure", () => {
  test("empty object is valid (since_ms is optional)", () => {
    expect(schema.safeParse({}).success).toBe(true);
  });

  test("argsSchema export is a plain object (not a ZodObject)", () => {
    // Ensure the schema file exports a raw field map, not a pre-wrapped ZodObject,
    // so the plugin can pass it directly to tool({ args: argsSchema }).
    expect(typeof argsSchema).toBe("object");
    expect(argsSchema).not.toBeInstanceOf(z.ZodObject);
  });
});
