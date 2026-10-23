/**
 * Pick a cheap model to run in-process summarization.
 *
 * Chats can be huge and summarization is a dumb map-reduce, so we don't want to
 * burn the user's default (often an expensive flagship) on it. Resolution order:
 *
 *   1. config.small_model  — OpenCode's dedicated "cheap tasks" setting
 *      ("provider/model"). If the user set it, honor it verbatim.
 *   2. Cheapest suitable model from provider.list(): connected provider, active
 *      status, text output, tool_call not required. Prefer well-known cheap
 *      families (haiku/mini/flash/small/lite/nano) to avoid picking some odd
 *      zero-cost-but-useless model; otherwise fall back to lowest input+output
 *      cost.
 *   3. null — caller omits `model` and lets OpenCode use its default.
 *
 * Pure function — takes the already-fetched config + providers, returns a plain
 * { providerID, modelID } or null. No I/O.
 */

const CHEAP_FAMILY = /haiku|mini|flash|small|lite|nano|8b|instant/i;

/**
 * @param {any} config    - client.config.get() data (may be null)
 * @param {any} providers - client.provider.list() data ({ all, default, connected })
 * @returns {{ providerID: string, modelID: string } | null}
 */
export function resolveSummaryModel(config, providers) {
  // 1. Explicit small_model wins.
  const small =
    config && typeof config.small_model === "string" ? config.small_model : "";
  const parsed = parseModelRef(small);
  if (parsed) return parsed;

  // 2. Scan available models for the cheapest suitable one.
  const all = Array.isArray(providers?.all) ? providers.all : [];
  const connected = new Set(
    Array.isArray(providers?.connected) ? providers.connected : [],
  );

  // Data-residency tie-break: prefer a cheap model from the SAME provider as the
  // user's main model, so a referenced chat's content doesn't silently cross to
  // a different vendor just because it's a cent cheaper.
  const preferredProvider =
    parseModelRef(typeof config?.model === "string" ? config.model : "")
      ?.providerID ?? null;

  /** @type {Array<{ providerID: string, modelID: string, cost: number, cheapFamily: boolean, preferred: boolean }>} */
  const candidates = [];

  for (const provider of all) {
    const providerID = provider?.id;
    if (!providerID) continue;
    // If we have a connected list, respect it; if it's empty, don't over-filter.
    if (connected.size > 0 && !connected.has(providerID)) continue;

    const models = provider?.models;
    if (!models || typeof models !== "object") continue;

    for (const key of Object.keys(models)) {
      const m = models[key];
      const modelID = m?.id ?? key;
      if (!modelID) continue;
      if (m?.status && m.status !== "active") continue;
      if (!hasTextOutput(m)) continue;

      const cost = costScore(m);
      candidates.push({
        providerID,
        modelID,
        cost,
        cheapFamily: CHEAP_FAMILY.test(modelID) || CHEAP_FAMILY.test(m?.name ?? ""),
        preferred: preferredProvider != null && providerID === preferredProvider,
      });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    // Prefer a known cheap family first, then the user's main provider
    // (data-residency), then lowest cost.
    if (a.cheapFamily !== b.cheapFamily) return a.cheapFamily ? -1 : 1;
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    return a.cost - b.cost;
  });

  const best = candidates[0];
  return { providerID: best.providerID, modelID: best.modelID };
}

/**
 * Parse "provider/model" (model id itself may contain slashes) into a ref.
 * @param {string} ref
 * @returns {{ providerID: string, modelID: string } | null}
 */
function parseModelRef(ref) {
  if (typeof ref !== "string") return null;
  const i = ref.indexOf("/");
  if (i <= 0 || i >= ref.length - 1) return null;
  return { providerID: ref.slice(0, i), modelID: ref.slice(i + 1) };
}

/**
 * A model can produce text output. Handles both the modalities array shape and
 * the absence of the field (assume text-capable if unspecified).
 * @param {any} m
 */
function hasTextOutput(m) {
  const out = m?.modalities?.output;
  if (!Array.isArray(out)) return true; // unspecified → assume usable
  return out.includes("text");
}

/**
 * Sort key: input+output cost. Missing cost sorts as +Infinity so priced models
 * are preferred over unknown-cost ones (which may be broken/unavailable).
 * @param {any} m
 */
function costScore(m) {
  const c = m?.cost;
  if (!c || typeof c.input !== "number" || typeof c.output !== "number") {
    return Number.POSITIVE_INFINITY;
  }
  return c.input + c.output;
}
