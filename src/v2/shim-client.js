/**
 * An OpenCode 1-shaped SDK client over an OpenCode 2 plugin context.
 *
 * The tool cores (src/extract-core.js, packages/refer-subchat/src/tool-core.js)
 * call `client.session.get({ path: { id } })` and friends and read `.data` off
 * the result. This shim answers those calls from the V2 context so the cores
 * run unchanged on both hosts; every V1/V2 difference is translated here.
 */

import { toV1Items } from "./adapt-messages.js";

/**
 * V2 Session.Info -> the V1 fields the cores read. V2 moved the directory under
 * `location`.
 * @param {any} s
 */
export function toV1Session(s) {
  if (!s || typeof s !== "object") return s;
  return { ...s, directory: s.location?.directory };
}

/**
 * V2 model list -> V1 `provider.list()` data ({ all, connected }), carrying only
 * the fields resolveSummaryModel reads. V2 lists only usable models and marks
 * the rest `enabled: false`, so `connected` stays empty (no extra filter).
 *
 * Pure function — no I/O.
 *
 * @param {readonly any[]} models V2 `Model.Info[]`
 */
export function toV1Providers(models) {
  /** @type {Map<string, { id: string, models: Record<string, object> }>} */
  const byProvider = new Map();
  for (const m of Array.isArray(models) ? models : []) {
    if (!m?.providerID || !m?.id) continue;
    const provider = byProvider.get(m.providerID) ?? { id: m.providerID, models: {} };
    const cost = Array.isArray(m.cost) ? m.cost[0] : undefined;
    provider.models[m.id] = {
      id: m.id,
      name: m.name,
      status: m.enabled === false ? "disabled" : (m.status ?? "active"),
      ...(cost ? { cost: { input: cost.input, output: cost.output } } : {}),
      ...(m.capabilities?.output ? { modalities: { output: m.capabilities.output } } : {}),
    };
    byProvider.set(m.providerID, provider);
  }
  return { all: [...byProvider.values()], connected: [] };
}

/** @param {any} res a V2 response that is either the payload or `{ data }` */
const unwrap = (res) => (res && typeof res === "object" && "data" in res ? res.data : res);

/**
 * @param {any} ctx OpenCode 2 plugin context
 * @param {object} [opts]
 * @param {(sessionID: string, items: any[]) => Promise<any[]>} [opts.augmentItems]
 *   extra history to merge into `session.messages` (the stored timeline).
 * @param {boolean} [opts.compaction=false] see toV1Items
 */
export function createShimClient(ctx, opts = {}) {
  return {
    session: {
      get: async ({ path }) => ({
        data: toV1Session(unwrap(await ctx.session.get({ sessionID: path.id }))),
      }),
      list: async ({ query } = {}) => {
        const page = unwrap(
          await ctx.session.list({
            ...(query?.directory ? { directory: query.directory } : {}),
            limit: 200,
            order: "desc",
          }),
        );
        const sessions = Array.isArray(page) ? page : (page?.data ?? []);
        return { data: sessions.map(toV1Session) };
      },
      messages: async ({ path }) => {
        const messages = unwrap(await ctx.session.context({ sessionID: path.id }));
        const items = toV1Items(messages, { compaction: opts.compaction === true });
        return { data: opts.augmentItems ? await opts.augmentItems(path.id, items) : items };
      },
    },
    config: {
      // V2 has no config read for plugins; the closest thing to V1's
      // `small_model` is the model of the built-in title agent.
      get: async () => {
        const agent = unwrap(await ctx.agent.get({ agentID: "title" }));
        const m = agent?.model;
        return { data: m?.providerID && m?.id ? { small_model: `${m.providerID}/${m.id}` } : {} };
      },
    },
    provider: {
      list: async () => ({ data: toV1Providers(unwrap(await ctx.model.list())) }),
    },
  };
}
