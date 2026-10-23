/**
 * Walk the session parentID chain upward and return the root session id.
 *
 * @param {object} client - OpenCode SDK client (must have `client.session.get`)
 * @param {string} startId - Session id to start walking from
 * @param {number} [maxHops=16] - Safety cap to prevent infinite loops on cycles / bugs
 * @returns {Promise<string>} Root session id
 */
export async function resolveRootSessionId(client, startId, maxHops = 16) {
  let currentId = startId;
  let lastGoodId = null;

  for (let hop = 0; hop < maxHops; hop++) {
    let resp;
    try {
      resp = await client.session.get({ path: { id: currentId } });
    } catch (err) {
      if (lastGoodId === null) {
        // Failed on the very first fetch — surface a clear error.
        throw new Error(
          `resolveRootSessionId: failed to fetch session "${currentId}": ${err?.message ?? err}`,
        );
      }
      // Mid-walk failure — fall back to the last successfully resolved id.
      return lastGoodId;
    }

    const session = resp?.data;
    if (!session) {
      if (lastGoodId === null) {
        throw new Error(
          `resolveRootSessionId: session "${currentId}" not found`,
        );
      }
      return lastGoodId;
    }

    lastGoodId = session.id ?? currentId;

    if (!session.parentID) {
      // No parent — this is the root.
      return lastGoodId;
    }

    currentId = session.parentID;
  }

  // Hit the hop cap — return last successfully fetched id.
  return lastGoodId ?? startId;
}
