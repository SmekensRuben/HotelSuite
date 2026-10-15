const { HttpsError } = require("firebase-functions/v2/https");

const INDEX_AREAS = Object.freeze({
  connections: {
    indexKey: "hotelMcpOAuthConnections",
    message: "Your MCP connections are temporarily unavailable because MCP setup is incomplete. Ask your operator to finish setup, then retry. Existing connections have not been changed.",
  },
  proposals: {
    indexKey: "hotelMcpProposalBatches",
    message: "Product proposals are temporarily unavailable because MCP setup is incomplete. Ask your operator to finish setup, then retry. Saved proposals have not been changed.",
  },
});

function isMcpIndexError(error) {
  if (![9, "9", "FAILED_PRECONDITION", "failed-precondition", "firestore/failed-precondition"].includes(error?.code)) return false;
  const message = [error.message, error.details].filter((value) => typeof value === "string").join(" ");
  return /\bquery\s+requires\s+(?:an?\s+)?(?:composite\s+)?index\b/i.test(message)
    || /\bindex\b[^.\r\n]{0,160}\b(?:building|being\s+built)\b/i.test(message)
    || /\b(?:required|composite)\s+index\s+(?:does\s+not\s+exist|is\s+missing|was\s+not\s+found)\b/i.test(message);
}

// Wrap only the indexed read, after its ordinary identity and access checks.
// Provider messages can contain setup URLs and query details; none are returned.
async function readMcpIndexQuery(area, read) {
  const configuration = INDEX_AREAS[area];
  if (!configuration) throw new Error("Unsupported MCP query area.");
  try { return await read(); }
  catch (error) {
    if (!isMcpIndexError(error)) throw error;
    throw new HttpsError("failed-precondition", configuration.message, {
      reason: "mcp-index-required", area, indexKey: configuration.indexKey,
    });
  }
}

module.exports = { isMcpIndexError, readMcpIndexQuery };
