function secureUrl(value, name, allowPath = true) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute URL.`); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.search || url.hash || (!allowPath && url.pathname !== "/")) {
    throw new Error(`${name} must use HTTPS without credentials, query, fragment${allowPath ? "" : " or a path"}.`);
  }
  return url;
}

function normalizeHotelMcpConfig(input = {}) {
  if (input.enabled !== true) return { enabled: false };
  const issuer = secureUrl(input.issuerUrl, "MCP issuer", false);
  const resource = secureUrl(input.resourceUrl || new URL("/mcp", issuer).href, "MCP resource");
  const app = secureUrl(input.appUrl, "Hotel Toolkit app URL");
  if (resource.origin !== issuer.origin || resource.pathname !== "/mcp") throw new Error("The MCP resource must be /mcp on its issuer origin.");
  if (!Array.isArray(input.clients) || !input.clients.length || input.clients.length > 20) {
    throw new Error("Configure between one and twenty private OAuth clients.");
  }
  const clients = input.clients.map((client) => {
    if (!client || typeof client.client_id !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(client.client_id)
      || !Array.isArray(client.redirect_uris) || !client.redirect_uris.length || client.redirect_uris.length > 10) {
      throw new Error("Every private OAuth client needs an ID and explicit redirect URIs.");
    }
    const redirectUris = client.redirect_uris.map((uri) => {
      let redirect;
      try { redirect = new URL(uri); } catch { throw new Error("OAuth redirect URIs must be absolute URLs."); }
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
      if ((redirect.protocol !== "https:" && !(redirect.protocol === "http:" && local))
        || redirect.username || redirect.password || redirect.hash) throw new Error("OAuth redirect URIs require HTTPS or loopback HTTP.");
      return redirect.href;
    });
    const method = client.token_endpoint_auth_method || "none";
    if (!["none", "client_secret_post"].includes(method)
      || (method === "client_secret_post" && (typeof client.client_secret !== "string" || client.client_secret.length < 32))
      || (method === "none" && client.client_secret)) throw new Error("Invalid private OAuth client authentication configuration.");
    return {
      client_id: client.client_id,
      client_name: typeof client.client_name === "string" && client.client_name.trim() ? client.client_name.trim().slice(0, 100) : client.client_id,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: method,
      ...(method === "client_secret_post" ? { client_secret: client.client_secret } : {}),
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    };
  });
  if (new Set(clients.map((client) => client.client_id)).size !== clients.length) throw new Error("OAuth client IDs must be unique.");
  const origins = [app.origin, ...(input.allowedOrigins || [])].map((value) => secureUrl(value, "Allowed browser origin", false).origin);
  return { enabled: true, issuerUrl: issuer.href, resourceUrl: resource.href, appUrl: app.href.replace(/\/$/, ""), clients, allowedOrigins: [...new Set(origins)] };
}


function requirePublicOrigin(value, name) {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error(`${name} must be a public HTTPS origin.`);
  }
  const url = secureUrl(value, name, false);
  const labels = url.hostname.split(".");
  if (url.protocol !== "https:" || url.port || labels.length < 2
    || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    || require("node:net").isIP(url.hostname)
    || /(?:^|\.)(?:localhost|local|localdomain|internal|lan)$|\.home\.arpa$/i.test(url.hostname)) {
    throw new Error(`${name} must be a public HTTPS origin without a port, credentials, path, query or fragment.`);
  }
  return url.origin;
}

// Shared by production parameter preparation and the public PKCE pilot runtime.
// The generic normalizer above also supports loopback-only HTTP protocol tests.
function normalizePublicHotelMcpConfig(input = {}) {
  if (input.enabled !== true) return { enabled: false };
  requirePublicOrigin(input.issuerUrl, "HOTEL_MCP_PUBLIC_ORIGIN");
  const app = secureUrl(input.appUrl, "Hotel Toolkit app URL");
  requirePublicOrigin(app.origin, "Hotel Toolkit app origin");
  if (!Array.isArray(input.allowedOrigins) || input.allowedOrigins.length > 20) {
    throw new Error("HOTEL_MCP_ALLOWED_ORIGINS_JSON must be an array of at most twenty public HTTPS origins.");
  }
  for (const origin of input.allowedOrigins) requirePublicOrigin(origin, "Allowed browser origin");
  if (!Array.isArray(input.clients) || input.clients.length < 1 || input.clients.length > 20) {
    throw new Error("Configure between one and twenty pre-registered public PKCE clients.");
  }
  const allowedKeys = new Set(["client_id", "client_name", "redirect_uris", "token_endpoint_auth_method"]);
  for (const client of input.clients) {
    if (!client || typeof client !== "object" || Array.isArray(client)
      || Object.hasOwn(client, "client_secret")
      || (client.token_endpoint_auth_method !== undefined && client.token_endpoint_auth_method !== "none")) {
      throw new Error("The private MCP pilot requires public PKCE clients without client secrets.");
    }
    if (Object.keys(client).some((key) => !allowedKeys.has(key))) throw new Error("OAuth clients contain unsupported configuration fields.");
    if (client.client_name !== undefined && (typeof client.client_name !== "string" || !client.client_name.trim()
      || client.client_name.length > 100 || /[\u0000-\u001f\u007f]/.test(client.client_name))) {
      throw new Error("OAuth client names must contain one to one hundred characters without control characters.");
    }
    if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.length || client.redirect_uris.length > 10) {
      throw new Error("Every public PKCE client needs one to ten exact redirect URIs.");
    }
    for (const uri of client.redirect_uris) {
      if (typeof uri !== "string" || uri.length > 2048 || /[\u0000-\u0020\u007f*]/.test(uri)) {
        throw new Error("OAuth redirect URIs must be exact URLs without wildcards or whitespace.");
      }
      let redirect;
      try { redirect = new URL(uri); } catch { throw new Error("OAuth redirect URIs must be absolute URLs."); }
      if (redirect.href !== uri || redirect.username || redirect.password || redirect.hash) {
        throw new Error("Register the exact canonical OAuth redirect URI without credentials or a fragment.");
      }
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
      if (loopback) {
        if (!["http:", "https:"].includes(redirect.protocol)) throw new Error("Loopback OAuth redirect URIs require HTTP or HTTPS.");
      } else requirePublicOrigin(redirect.origin, "OAuth redirect origin");
    }
    if (new Set(client.redirect_uris).size !== client.redirect_uris.length) throw new Error("OAuth redirect URIs must be unique for each client.");
  }
  return normalizeHotelMcpConfig(input);
}

module.exports = { normalizeHotelMcpConfig, normalizePublicHotelMcpConfig };
