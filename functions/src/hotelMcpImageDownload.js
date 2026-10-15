const https = require("node:https");
const dns = require("node:dns/promises");
const tls = require("node:tls");
const { BlockList, isIP } = require("node:net");
const { HttpsError } = require("firebase-functions/v2/https");

const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_MS = 15_000;
const MAX_REDIRECTS = 3;
const SAFE_ERROR = Symbol("safe-proposal-image-error");
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blockedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList(); globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["2620:4f:8000::", 48],
  ["3ffe::", 16], ["3fff::", 20],
]) blockedV6.addSubnet(address, prefix, "ipv6");

function imageError(code = "invalid-argument") {
  const message = code === "invalid-argument"
    ? "Use a direct public HTTPS JPEG, PNG or WebP image URL with an image of at most 5 MiB."
    : "The image could not be downloaded. Try another public image URL or upload the image in Hotel Toolkit.";
  const error = new HttpsError(code, message);
  Object.defineProperty(error, SAFE_ERROR, { value: true });
  return error;
}

function isPublicImageAddress(address) {
  if (typeof address !== "string" || address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  // Only ordinary global-unicast IPv6 is accepted. This excludes mapped,
  // compatible and NAT64 forms even when their embedded IPv4 address is public.
  return family === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}

function imageUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || !/^https:\/\//i.test(value)
    || /[\u0000-\u0020\u007f-\u009f\\#]/.test(value)) throw imageError();
  let url;
  try { url = new URL(value); } catch { throw imageError(); }
  const authority = value.slice(value.indexOf("//") + 2).split(/[/?]/, 1)[0];
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || authority.includes("@")) throw imageError();
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (!isPublicImageAddress(hostname)) throw imageError();
  } else if (hostname.length > 253 || hostname.split(".").length < 2
    || hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    || /(?:^|\.)(?:localhost|local|localdomain|internal|lan)$|\.home\.arpa$/i.test(hostname)) throw imageError();
  return { url, hostname };
}

function withDeadline(promise, signal) {
  if (signal.aborted) return Promise.reject(imageError("unavailable"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(imageError("unavailable"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function resolvePublicAddress(hostname, lookup, signal) {
  if (signal.aborted) throw imageError("unavailable");
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }]
    : await withDeadline(lookup(hostname, { all: true, verbatim: true }), signal);
  if (!Array.isArray(addresses) || !addresses.length) throw imageError("unavailable");
  if (addresses.length > 32 || addresses.some((entry) => !entry || !isPublicImageAddress(entry.address)
    || entry.family !== isIP(entry.address))) throw imageError();
  return { address: addresses[0].address, family: addresses[0].family };
}

function pinnedLookup(hostname, address) {
  return (requested, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    if (requested !== hostname) return callback(imageError("unavailable"));
    if (options?.all) return callback(null, [{ ...address }]);
    return callback(null, address.address, address.family);
  };
}

function readImage({ url, hostname }, address, request, signal) {
  return new Promise((resolve, reject) => {
    let outgoing, incoming, finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true; signal.removeEventListener("abort", abort);
      if (error) { incoming?.destroy(); outgoing?.destroy(); reject(error); }
      else resolve(result);
    };
    const abort = () => finish(imageError("unavailable"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    try {
      outgoing = request({
        protocol: "https:", hostname, port: 443, method: "GET", path: `${url.pathname}${url.search}`,
        servername: isIP(hostname) ? "" : hostname, rejectUnauthorized: true, checkServerIdentity: tls.checkServerIdentity,
        lookup: pinnedLookup(hostname, address), family: address.family, autoSelectFamily: false,
        agent: false, maxHeaderSize: 16 * 1024, signal,
        headers: { Accept: "image/jpeg, image/png, image/webp", "Accept-Encoding": "identity", "User-Agent": "HotelToolkit-MCP-Image/1.0", Connection: "close" },
      }, (response) => {
        incoming = response;
        if (finished) { response.destroy(); return; }
        response.once("error", () => finish(imageError("unavailable")));
        response.once("aborted", () => finish(imageError("unavailable")));
        response.once("close", () => { if (!finished) finish(imageError("unavailable")); });
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = response.headers.location;
          if (typeof location !== "string" || !location || location.length > 2048 || /[\u0000-\u0020\u007f-\u009f\\#]/.test(location)) { finish(imageError()); return; }
          let next;
          try { next = new URL(location, url).href; } catch { finish(imageError()); return; }
          finish(null, { redirect: next }); response.destroy(); outgoing?.destroy(); return;
        }
        if (response.statusCode !== 200) { finish(imageError("unavailable")); return; }
        const encoding = response.headers["content-encoding"];
        if (encoding !== undefined && (typeof encoding !== "string" || encoding.trim().toLowerCase() !== "identity")) { finish(imageError()); return; }
        const type = response.headers["content-type"];
        const mimeType = typeof type === "string" ? type.split(";", 1)[0].trim().toLowerCase() : "";
        if (!IMAGE_MIMES.has(mimeType)) { finish(imageError()); return; }
        const declared = response.headers["content-length"];
        if (declared !== undefined && (typeof declared !== "string" || !/^\d+$/.test(declared)
          || Number(declared) < 1 || Number(declared) > MAX_DOWNLOAD_BYTES)) { finish(imageError()); return; }
        const chunks = []; let length = 0;
        response.on("data", (chunk) => {
          if (finished) return;
          if (!Buffer.isBuffer(chunk) || chunk.length > MAX_DOWNLOAD_BYTES - length) { finish(imageError()); return; }
          chunks.push(chunk); length += chunk.length;
        });
        response.once("end", () => {
          if (!length || (declared !== undefined && length !== Number(declared))) { finish(imageError()); return; }
          finish(null, { bytes: Buffer.concat(chunks, length), mimeType, sourceUrl: url.href });
        });
      });
      outgoing.once("error", () => finish(imageError("unavailable")));
      outgoing.end();
    } catch { finish(imageError("unavailable")); }
  });
}

async function downloadProposalImage(value, services = {}) {
  const timeout = Number.isFinite(services.timeoutMs) && services.timeoutMs > 0 ? Math.min(MAX_DOWNLOAD_MS, services.timeoutMs) : MAX_DOWNLOAD_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let target = imageUrl(value);
    for (let redirects = 0; ; redirects += 1) {
      const address = await resolvePublicAddress(target.hostname, services.lookup || dns.lookup, controller.signal);
      const result = await readImage(target, address, services.request || https.request, controller.signal);
      if (!result.redirect) return result;
      if (redirects >= MAX_REDIRECTS) throw imageError();
      target = imageUrl(result.redirect);
    }
  } catch (error) {
    if (error?.[SAFE_ERROR]) throw error;
    throw imageError("unavailable");
  } finally { clearTimeout(timer); }
}

module.exports = { downloadProposalImage, isPublicImageAddress, MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_MS, MAX_REDIRECTS };
