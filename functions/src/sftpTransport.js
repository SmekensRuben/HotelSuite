const { createHash } = require("node:crypto");
const dns = require("node:dns/promises");
const { SftpClient } = require("./config");
const { buildOrderSftpCsv } = require("./mailQueue");

function resolveSftpConnectionOptions(value, { requirePassword = true } = {}) {
  let url;
  if (typeof value.sftpAddress !== "string" || /(^|\/)\.{1,2}(\/|$)/.test(decodeURIComponent(value.sftpAddress))) throw new Error("Use an SFTP folder without relative segments.");
  try { url = new URL(value.sftpAddress.includes("://") ? value.sftpAddress : `sftp://${value.sftpAddress}`); }
  catch { throw new Error("Use a valid SFTP hostname and remote folder."); }
  const port = Number(value.sftpPort || url.port || 22);
  if (url.protocol !== "sftp:" || (value.sftpProtocol && value.sftpProtocol !== "sftp")
    || url.username || url.password || url.search || url.hash || !url.hostname
    || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SFTP connection configuration.");
  const directory = decodeURIComponent(url.pathname || "/");
  if (/[\\\u0000-\u001f]/.test(directory) || directory.split("/").some((p) => p === ".." || p === ".")) throw new Error("Use an absolute remote folder without relative segments.");
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(value.sftpHostKey || "")) throw new Error("A verified SHA256 SFTP host key is required.");
  if (!value.sftpUser || (requirePassword && !value.sftpPassword)) throw new Error("SFTP username and password are required.");
  return { host: url.hostname, port, username: value.sftpUser, password: value.sftpPassword,
    remoteDir: directory.replace(/\/$/, ""), hostKey: value.sftpHostKey.replace(/=$/, "") };
}

function publicIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

async function sendOrderBySftp(order, credentials, context = {}, services = {}) {
  const config = resolveSftpConnectionOptions(credentials);
  const addresses = await (services.lookup || dns.lookup)(config.host, { all: true, family: 4 });
  if (!addresses.length || addresses.some(({ address }) => !publicIpv4(address))) throw new Error("SFTP must resolve to a public IPv4 address.");
  const client = services.client || new SftpClient();
  const identity = createHash("sha256").update(`${context.hotelUid}/${context.orderId}`).digest("hex");
  const finalPath = `${config.remoteDir}/hotelsuite-${identity}.csv`;
  const tempPath = `${finalPath}.pending`;
  const csv = Buffer.from(buildOrderSftpCsv(order, {}), "utf8");
  // Pin both the resolved address and the server key; do not trust DNS during connect.
  try {
    await client.connect({ host: addresses[0].address, port: config.port, username: config.username,
      password: config.password, readyTimeout: 15000, retries: 0,
      hostVerifier: (key) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=$/, "")}` === config.hostKey });
    if (await client.exists(finalPath)) {
      const stat = await client.stat(finalPath);
      if (stat.size !== csv.length || stat.size > 1_000_000) throw new Error("An existing remote order file needs operator review.");
      const existing = await client.get(finalPath);
      if (!Buffer.isBuffer(existing) || !existing.equals(csv)) throw new Error("An existing remote order file needs operator review.");
      return { remotePath: finalPath, existing: true };
    }
    context.markExternalAttempt?.();
    await client.put(csv, tempPath);
    // The supplier sees a complete file, with a stable identity for this order.
    await client.rename(tempPath, finalPath);
    return { remotePath: finalPath, existing: false };
  } finally { await client.end().catch(() => {}); }
}

module.exports = { resolveSftpConnectionOptions, publicIpv4, sendOrderBySftp };
