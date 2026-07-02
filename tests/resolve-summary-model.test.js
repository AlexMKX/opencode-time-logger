import { describe, expect, test } from "bun:test";
import { resolveSummaryModel } from "../src/resolve-summary-model.js";

const providers = (all, connected = [], defaultMap = {}) => ({
  all,
  connected,
  default: defaultMap,
});

const provider = (id, models) => ({ id, models });

const model = (id, cost, extra = {}) => ({
  id,
  name: extra.name ?? id,
  status: extra.status ?? "active",
  cost,
  modalities: extra.modalities,
});

describe("resolveSummaryModel", () => {
  test("config.small_model wins verbatim", () => {
    const out = resolveSummaryModel(
      { small_model: "anthropic/claude-haiku-4-5" },
      providers([provider("openai", { gpt: model("gpt-4", { input: 1, output: 1 }) })]),
    );
    expect(out).toEqual({ providerID: "anthropic", modelID: "claude-haiku-4-5" });
  });

  test("small_model with slashes in the model id", () => {
    const out = resolveSummaryModel(
      { small_model: "prov/org/model-x" },
      providers([]),
    );
    expect(out).toEqual({ providerID: "prov", modelID: "org/model-x" });
  });

  test("no config + no providers -> null (caller uses default)", () => {
    expect(resolveSummaryModel(null, null)).toBeNull();
    expect(resolveSummaryModel({}, providers([]))).toBeNull();
  });

  test("prefers cheap family over merely-cheapest", () => {
    const out = resolveSummaryModel(
      {},
      providers(
        [
          provider("anthropic", {
            opus: model("claude-opus", { input: 15, output: 75 }),
            haiku: model("claude-haiku", { input: 1, output: 5 }),
          }),
          provider("weird", {
            free: model("free-but-unknown", { input: 0, output: 0 }),
          }),
        ],
        ["anthropic", "weird"],
      ),
    );
    // haiku is cheap-family; free-but-unknown is cheaper but not a known family
    expect(out).toEqual({ providerID: "anthropic", modelID: "claude-haiku" });
  });

  test("tie-break: prefers cheap model of the main provider (data-residency)", () => {
    const out = resolveSummaryModel(
      { model: "anthropic/claude-sonnet-4-6" },
      providers(
        [
          provider("anthropic", { h: model("claude-haiku", { input: 1, output: 5 }) }),
          provider("openai", { m: model("gpt-mini", { input: 0.1, output: 0.4 }) }),
        ],
        ["anthropic", "openai"],
      ),
    );
    // gpt-mini is cheaper, but both are cheap-family; same-provider wins.
    expect(out).toEqual({ providerID: "anthropic", modelID: "claude-haiku" });
  });

  test("no main provider -> cheapest cheap-family wins", () => {
    const out = resolveSummaryModel(
      {},
      providers(
        [
          provider("anthropic", { h: model("claude-haiku", { input: 1, output: 5 }) }),
          provider("openai", { m: model("gpt-mini", { input: 0.1, output: 0.4 }) }),
        ],
        ["anthropic", "openai"],
      ),
    );
    expect(out).toEqual({ providerID: "openai", modelID: "gpt-mini" });
  });

  test("falls back to cheapest when no cheap family present", () => {
    const out = resolveSummaryModel(
      {},
      providers(
        [
          provider("p", {
            big: model("big-model", { input: 10, output: 10 }),
            mid: model("mid-model", { input: 2, output: 3 }),
          }),
        ],
        ["p"],
      ),
    );
    expect(out).toEqual({ providerID: "p", modelID: "mid-model" });
  });

  test("skips non-connected providers when connected list present", () => {
    const out = resolveSummaryModel(
      {},
      providers(
        [
          provider("offline", { h: model("offline-haiku", { input: 0.1, output: 0.1 }) }),
          provider("online", { m: model("online-mini", { input: 1, output: 1 }) }),
        ],
        ["online"],
      ),
    );
    expect(out).toEqual({ providerID: "online", modelID: "online-mini" });
  });

  test("skips deprecated/non-active and non-text-output models", () => {
    const out = resolveSummaryModel(
      {},
      providers(
        [
          provider("p", {
            dep: model("dep-mini", { input: 0.1, output: 0.1 }, { status: "deprecated" }),
            img: model("image-mini", { input: 0.1, output: 0.1 }, { modalities: { input: ["text"], output: ["image"] } }),
            ok: model("text-mini", { input: 1, output: 1 }, { modalities: { input: ["text"], output: ["text"] } }),
          }),
        ],
        ["p"],
      ),
    );
    expect(out).toEqual({ providerID: "p", modelID: "text-mini" });
  });

  test("empty connected list does not over-filter", () => {
    const out = resolveSummaryModel(
      {},
      providers([provider("p", { h: model("mini", { input: 1, output: 1 }) })], []),
    );
    expect(out).toEqual({ providerID: "p", modelID: "mini" });
  });
});
