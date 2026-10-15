import { auth, functions, httpsCallable } from "../firebaseConfig";

const opaqueId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const text = (value, max = 500) => typeof value === "string" && value.length > 0 && value.length <= max;
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;

function publicUrl(value) {
  if (!text(value, 4000)) throw new Error("The MCP connection address could not be verified.");
  let url;
  try { url = new URL(value); } catch { throw new Error("The MCP connection address could not be verified."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("The MCP connection address could not be verified.");
  }
  return url;
}

async function invoke(endpoint, input) {
  const actor = auth.currentUser;
  if (!actor?.uid || actor.emailVerified !== true) throw new Error("Sign in with a verified Hotel Toolkit account to manage MCP connections.");
  const assertCurrent = () => {
    if (auth.currentUser !== actor || actor.emailVerified !== true) throw new Error("Your account changed. Reopen MCP connections with the original account.");
  };
  assertCurrent();
  try {
    const { data } = await httpsCallable(functions, endpoint)(input);
    assertCurrent();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The MCP connection response could not be verified.");
    return data;
  } catch (failure) {
    assertCurrent();
    throw new Error(String(failure?.message || "The MCP connection could not be completed. Try again.").replace(/^Firebase:\s*/i, "").slice(0, 1000));
  }
}

export async function getMcpConsent(requestId) {
  if (!opaqueId(requestId)) throw new Error("Open the authorization link supplied by your MCP client.");
  const data = await invoke("getHotelMcpConsent", { requestId });
  if (data.requestId !== requestId || !text(data.client?.name) || !timestamp(data.expiresAt)
    || !Array.isArray(data.scopes) || !data.scopes.length || data.scopes.length > 20
    || data.scopes.some((scope) => !text(scope?.id, 100) || !text(scope.label, 200) || !text(scope.description, 1000))) {
    throw new Error("The MCP authorization request could not be verified. Start again from your client.");
  }
  const redirect = publicUrl(data.client.redirectOrigin);
  if (redirect.origin !== data.client.redirectOrigin) throw new Error("The MCP client's return address could not be verified.");
  return { requestId, client: { name: data.client.name, redirectOrigin: redirect.origin },
    scopes: data.scopes.map(({ id, label, description }) => ({ id, label, description })), expiresAt: data.expiresAt };
}

export async function completeMcpConsent(requestId, approve, expectedRedirectOrigin) {
  if (!opaqueId(requestId) || typeof approve !== "boolean") throw new Error("Use a valid MCP authorization request.");
  const expected = publicUrl(expectedRedirectOrigin);
  if (expected.origin !== expectedRedirectOrigin) throw new Error("Reopen the MCP authorization request before continuing.");
  const data = await invoke("completeHotelMcpConsent", { requestId, approve });
  const redirect = publicUrl(data.redirectUrl);
  if (redirect.origin !== expected.origin) throw new Error("The MCP client's return address changed. Start again from your client.");
  return { redirectUrl: redirect.href };
}

export async function listMcpConnections() {
  const data = await invoke("listHotelMcpConnections", {});
  if (!Array.isArray(data.connections) || data.connections.length > 1000
    || typeof data.configuration?.enabled !== "boolean"
    || data.connections.some((row) => !opaqueId(row?.id) || !text(row.clientName) || !timestamp(row.createdAt)
      || !timestamp(row.expiresAt) || !Array.isArray(row.scopes) || row.scopes.some((scope) => !text(scope, 100)))) {
    throw new Error("Your MCP connections could not be verified. Reload this page.");
  }
  const resourceUrl = data.configuration.resourceUrl ? publicUrl(data.configuration.resourceUrl).href : null;
  return { connections: data.connections.map(({ id, clientName, scopes, createdAt, expiresAt }) => ({ id, clientName, scopes: [...scopes], createdAt, expiresAt })),
    configuration: { enabled: data.configuration.enabled, resourceUrl } };
}

export async function revokeMcpConnection(connectionId) {
  if (!opaqueId(connectionId)) throw new Error("Choose a valid MCP connection to revoke.");
  const data = await invoke("revokeHotelMcpConnection", { connectionId });
  if (data.revoked !== true) throw new Error("Revocation could not be verified. Retry revoking this connection.");
  return { revoked: true };
}
