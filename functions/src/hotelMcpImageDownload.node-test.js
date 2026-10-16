require("../testSupport/productionEnvironment").activateProductionTestEnvironment();
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const tls = require("node:tls");
const { downloadProposalImage, isPublicImageAddress, MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_MS, MAX_REDIRECTS } = require("./hotelMcpImageDownload");

const publicAnswers = [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
const image = (overrides = {}) => ({ status: 200, headers: { "content-type": "image/webp" }, chunks: [Buffer.from("fixture-image-bytes")], ...overrides });

function networkFixture(replies = [image()], options = {}) {
  const calls = [], lookups = [], responses = [];
  const lookup = async (hostname, settings) => {
    lookups.push({ hostname, settings });
    return options.lookup ? options.lookup(hostname, settings, lookups.length) : publicAnswers;
  };
  const request = (settings, onResponse) => {
    const outgoing = new EventEmitter(); outgoing.destroyed = false;
    const position = calls.length; calls.push({ settings, outgoing });
    let incoming;
    outgoing.destroy = () => { outgoing.destroyed = true; incoming?.destroy(); return outgoing; };
    outgoing.end = () => {
      const deliver = () => {
        if (outgoing.destroyed) return;
        const reply = replies[position];
        if (!reply || reply.connectStalls) return;
        if (reply.error) { outgoing.emit("error", reply.error); return; }
        incoming = reply.bodyStalls ? new Readable({ read() {} }) : Readable.from(reply.chunks || []);
        incoming.statusCode = reply.status; incoming.headers = reply.headers || {};
        responses.push(incoming); onResponse(incoming);
        if (reply.bodyStalls) incoming.push(Buffer.from("partial-image"));
        if (reply.aborted) incoming.emit("aborted");
        if (reply.earlyClose) incoming.destroy();
      };
      const delay = replies[position]?.delay;
      if (delay) setTimeout(deliver, delay); else queueMicrotask(deliver);
      return outgoing;
    };
    return outgoing;
  };
  return { services: { lookup, request, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }, calls, lookups, responses };
}

const invalid = (error) => error.code === "invalid-argument" && !/https?:\/\/|metadata|private|secret|token=|supplier\.com/.test(error.message);
const unavailable = (error) => error.code === "unavailable" && !/https?:\/\/|metadata|private|secret|token=|supplier\.com/.test(error.message);

test("image addresses exclude local, reserved, documentation, multicast and transition ranges", () => {
  for (const address of ["0.0.0.0", "0.255.255.255", "10.1.2.3", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.254",
    "192.0.0.9", "192.0.2.1", "192.31.196.1", "192.52.193.1", "192.88.99.1", "192.168.1.1", "192.175.48.1", "198.18.0.1", "198.19.255.254", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.1.1.1", "240.1.1.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::ffff:7f00:1", "::8.8.8.8", "64:ff9b::808:808", "64:ff9b:1::808:808", "100::1", "2001::1", "2001:2::1", "2001:10::1", "2001:20::1", "2001:db8::1", "2002:0808:0808::1", "2620:4f:8000::1", "3ffe::1", "3fff::1", "fc00::1", "fd00::1", "fe80::1", "fe80::1%eth0", "ff02::1", "5f00::1", "not-an-address"]) {
    assert.equal(isPublicImageAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.128.0.1", "172.32.0.1", "192.169.0.1", "2001:4860:4860::8888", "2606:4700:4700::1111", "2001:67c:2e8::1"]) {
    assert.equal(isPublicImageAddress(address), true, address);
  }
});

test("only direct HTTPS URLs on port 443 reach DNS and numeric or encoded local addresses cannot bypass validation", async () => {
  const f = networkFixture();
  for (const url of [null, "", "http://cdn.supplier.com/image.png", "file:///etc/passwd", "https:/cdn.supplier.com/image.png", "https://cdn.supplier.com:8443/image.png", "https://user:secret@cdn.supplier.com/image.png", "https://@cdn.supplier.com/image.png", "https://cdn.supplier.com/image.png#fragment", "https://cdn.supplier.com/image.png#", "https://cdn.supplier.com/image.png\n", "https://cdn.supplier.com/image.png\u0085", "https://cdn.supplier.com/image with spaces.png", "https://localhost/image.png", "https://metadata.google.internal/computeMetadata/v1", "https://site.local/image.png", "https://site.home.arpa/image.png", "https://127.0.0.1/image.png", "https://2130706433/image.png", "https://0x7f000001/image.png", "https://0177.0.0.1/image.png", "https://%31%32%37.0.0.1/image.png", "https://[::ffff:8.8.8.8]/image.png", "https://[2002:0808:0808::1]/image.png", `https://cdn.supplier.com/${"a".repeat(2048)}`]) {
    await assert.rejects(downloadProposalImage(url, f.services), invalid, String(url));
  }
  assert.equal(f.lookups.length, 0); assert.equal(f.calls.length, 0);
});

test("DNS validates every answer and never connects when any address is unsafe or malformed", async () => {
  for (const answers of [[publicAnswers[0], { address: "127.0.0.1", family: 4 }], [publicAnswers[1], { address: "fd00::1", family: 6 }],
    [{ address: "::ffff:93.184.216.34", family: 6 }], [{ address: "93.184.216.34", family: 6 }], [{ address: "invalid", family: 4 }], Array.from({ length: 33 }, () => publicAnswers[0])]) {
    const f = networkFixture([image()], { lookup: async () => answers });
    await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.webp", f.services), invalid);
    assert.equal(f.calls.length, 0);
  }
  const f = networkFixture([image()], { lookup: async () => [] });
  await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.webp", f.services), unavailable);
  assert.equal(f.calls.length, 0);
});

test("validated DNS is pinned to the connection while original hostname, SNI and certificate verification remain active", async () => {
  const f = networkFixture([image()], { lookup: async (_host, _settings, count) => count === 1 ? publicAnswers : [{ address: "127.0.0.1", family: 4 }] });
  const result = await downloadProposalImage("https://cdn.supplier.com/image.webp?token=source-secret", f.services);
  assert.equal(result.bytes.toString(), "fixture-image-bytes"); assert.equal(result.mimeType, "image/webp");
  assert.equal(result.sourceUrl, "https://cdn.supplier.com/image.webp?token=source-secret");
  assert.deepEqual(f.lookups, [{ hostname: "cdn.supplier.com", settings: { all: true, verbatim: true } }]);
  const settings = f.calls[0].settings;
  assert.equal(settings.hostname, "cdn.supplier.com"); assert.equal(settings.servername, "cdn.supplier.com");
  assert.equal(settings.port, 443); assert.equal(settings.protocol, "https:"); assert.equal(settings.method, "GET");
  assert.equal(settings.rejectUnauthorized, true); assert.equal(settings.checkServerIdentity, tls.checkServerIdentity);
  assert.equal(settings.checkServerIdentity("cdn.supplier.com", { subjectaltname: "DNS:attacker.com" }) instanceof Error, true);
  assert.equal(settings.checkServerIdentity("cdn.supplier.com", { subjectaltname: "DNS:cdn.supplier.com" }), undefined);
  assert.equal(settings.agent, false); assert.equal(settings.autoSelectFamily, false); assert.equal(settings.family, 4);
  assert.equal(settings.maxHeaderSize, 16 * 1024);
  assert.deepEqual(settings.headers, { Accept: "image/jpeg, image/png, image/webp", "Accept-Encoding": "identity", "User-Agent": "HotelToolkit-MCP-Image/1.0", Connection: "close" });
  const single = await new Promise((resolve, reject) => settings.lookup("cdn.supplier.com", {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(single, publicAnswers[0]);
  const all = await new Promise((resolve, reject) => settings.lookup("cdn.supplier.com", { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(all, [publicAnswers[0]]);
  await assert.rejects(new Promise((resolve, reject) => settings.lookup("metadata.google.internal", {}, (error) => error ? reject(error) : resolve())), unavailable);
  assert.equal(f.lookups.length, 1);
});

test("public literal addresses require no DNS and IPv6 connections retain IP certificate verification", async () => {
  for (const [url, hostname, family] of [["https://8.8.8.8/image.png", "8.8.8.8", 4], ["https://[2606:4700:4700::1111]/image.png", "2606:4700:4700::1111", 6]]) {
    const f = networkFixture([image({ headers: { "content-type": "image/png" } })]);
    await downloadProposalImage(url, f.services);
    assert.equal(f.lookups.length, 0); assert.equal(f.calls[0].settings.hostname, hostname);
    assert.equal(f.calls[0].settings.family, family); assert.equal(f.calls[0].settings.servername, "");
    assert.equal(f.calls[0].settings.rejectUnauthorized, true);
  }
});

test("each redirect revalidates DNS and drops cookies and authorization rather than following an authenticated session", async () => {
  const f = networkFixture([
    image({ status: 302, headers: { location: "/next.png", "set-cookie": "session=source-secret" } }),
    image({ status: 307, headers: { location: "https://images.other-supplier.com/final.png" } }),
    image({ headers: { "content-type": "image/png; charset=binary", "content-length": "19" } }),
  ]);
  const result = await downloadProposalImage("https://cdn.supplier.com/original.webp?token=source-secret", f.services);
  assert.equal(result.sourceUrl, "https://images.other-supplier.com/final.png"); assert.equal(result.mimeType, "image/png");
  assert.deepEqual(f.lookups.map((call) => call.hostname), ["cdn.supplier.com", "cdn.supplier.com", "images.other-supplier.com"]);
  assert.deepEqual(f.calls.map((call) => call.settings.path), ["/original.webp?token=source-secret", "/next.png", "/final.png"]);
  assert.equal(new Set(f.calls.map((call) => call.settings.signal)).size, 1);
  for (const { settings } of f.calls) {
    for (const key of ["Authorization", "authorization", "Proxy-Authorization", "Cookie", "Referer", "Origin"]) assert.equal(Object.hasOwn(settings.headers, key), false);
    assert.equal(Object.hasOwn(settings, "auth"), false);
  }
  assert.equal(f.responses[0].destroyed, true); assert.equal(f.responses[1].destroyed, true);
});

test("redirects cannot downgrade HTTPS, target internal addresses or rebind the original hostname", async () => {
  for (const location of ["http://cdn.supplier.com/image.png", "https://127.0.0.1/image.png", "https://[::1]/image.png", "https://user:secret@cdn.supplier.com/image.png", "https://cdn.supplier.com:8443/image.png", "https://cdn.supplier.com/image.png#fragment", "/image.png\r\nCookie:secret"]) {
    const f = networkFixture([image({ status: 302, headers: { location } })]);
    await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.webp", f.services), invalid);
    assert.equal(f.calls.length, 1);
  }
  const f = networkFixture([image({ status: 302, headers: { location: "/next.png" } })], { lookup: async (_host, _settings, count) => count === 1 ? publicAnswers : [{ address: "169.254.169.254", family: 4 }] });
  await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.webp", f.services), invalid);
  assert.equal(f.lookups.length, 2); assert.equal(f.calls.length, 1);
});

test("at most three redirects are followed and redirect bodies are never buffered", async () => {
  const replies = Array.from({ length: MAX_REDIRECTS + 1 }, () => image({ status: 302, headers: { location: "/again.png" }, chunks: [Buffer.alloc(MAX_DOWNLOAD_BYTES + 1)] }));
  const f = networkFixture(replies);
  await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.webp", f.services), invalid);
  assert.equal(f.calls.length, 4); assert.equal(f.responses.every((response) => response.destroyed), true);
  for (const headers of [{}, { location: ["/a", "/b"] }]) {
    const invalidRedirect = networkFixture([image({ status: 302, headers })]);
    await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.webp", invalidRedirect.services), invalid);
  }
});

test("unsupported image types and compressed responses are rejected without decoding", async () => {
  for (const type of [undefined, "image/svg+xml", "image/gif", "text/html", "application/json", "image/jpeg,image/png"]) {
    const f = networkFixture([image({ headers: type ? { "content-type": type } : {} })]);
    await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.webp", f.services), invalid);
    assert.equal(f.responses[0].destroyed, true);
  }
  for (const encoding of ["gzip", "deflate", "br", "identity, gzip", ["identity", "gzip"]]) {
    const f = networkFixture([image({ headers: { "content-type": "image/png", "content-encoding": encoding } })]);
    await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.png", f.services), invalid);
  }
  for (const type of ["image/jpeg", "image/png", "image/webp"]) {
    const f = networkFixture([image({ headers: { "content-type": type, "content-encoding": "identity" } })]);
    assert.equal((await downloadProposalImage("https://cdn.supplier.com/image", f.services)).mimeType, type);
  }
});

test("declared and streamed image sizes are bounded before image decoding or storage", async () => {
  for (const declared of ["0", "-1", String(MAX_DOWNLOAD_BYTES + 1), "invalid", "1,2", ["1", "2"]]) {
    const f = networkFixture([image({ headers: { "content-type": "image/png", "content-length": declared } })]);
    await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.png", f.services), invalid);
    assert.equal(f.responses[0].destroyed, true);
  }
  for (const chunks of [[], [Buffer.alloc(MAX_DOWNLOAD_BYTES), Buffer.from("x")], [Buffer.alloc(MAX_DOWNLOAD_BYTES + 1)]]) {
    const f = networkFixture([image({ chunks })]);
    await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.png", f.services), invalid);
  }
  const exact = networkFixture([image({ chunks: [Buffer.alloc(MAX_DOWNLOAD_BYTES)], headers: { "content-type": "image/png", "content-length": String(MAX_DOWNLOAD_BYTES) } })]);
  assert.equal((await downloadProposalImage("https://cdn.supplier.com/image.png", exact.services)).bytes.length, MAX_DOWNLOAD_BYTES);
  const mismatch = networkFixture([image({ headers: { "content-type": "image/png", "content-length": "100" } })]);
  await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.png", mismatch.services), invalid);
});

test("one total deadline bounds DNS, connection, redirects and stalled image bodies", async () => {
  assert.equal(MAX_DOWNLOAD_MS, 15_000);
  const stalledDns = networkFixture([], { timeoutMs: 15, lookup: async () => new Promise(() => {}) });
  await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.png", stalledDns.services), unavailable);
  assert.equal(stalledDns.calls.length, 0);
  for (const reply of [{ connectStalls: true }, image({ bodyStalls: true })]) {
    const f = networkFixture([reply], { timeoutMs: 15 });
    await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.png", f.services), unavailable);
    assert.equal(f.calls[0].outgoing.destroyed, true);
  }
  const f = networkFixture([image({ status: 302, headers: { location: "/later.png" }, delay: 10 }), image({ bodyStalls: true })], { timeoutMs: 30 });
  await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.png", f.services), unavailable);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].settings.signal, f.calls[1].settings.signal);
  assert.equal(f.calls[1].settings.signal.aborted, true);
});

test("provider failures, certificate errors and aborted responses return fixed errors without URL or query secrets and do not retry", async () => {
  const f = networkFixture([image()], { lookup: async () => { throw new Error("DNS source-secret cdn.supplier.com?token=source-secret"); } });
  await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.webp?token=source-secret", f.services), unavailable);
  assert.equal(f.calls.length, 0); assert.equal(f.lookups.length, 1);
  for (const reply of [image({ status: 403 }), image({ status: 500 }), { error: new Error("TLS certificate source-secret token=source-secret") }, image({ aborted: true }), image({ bodyStalls: true, earlyClose: true })]) {
    const failed = networkFixture([reply]);
    await assert.rejects(downloadProposalImage("https://cdn.supplier.com/image.webp?token=source-secret", failed.services), (error) => {
      assert.equal(unavailable(error), true);
      assert.equal(JSON.stringify(error.toJSON()).includes("source-secret"), false);
      return true;
    });
    assert.equal(failed.calls.length, 1);
  }
});
