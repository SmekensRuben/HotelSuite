const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { resolveSftpConnectionOptions, publicIpv4, sendOrderBySftp } = require("./sftpTransport");
const { supplierPublicView } = require("./suppliers");
const { dateOnly, deliveryDate, cartInput } = require("./orders");
const { requireVerifiedUser } = require("./validation");

const serverKey = Buffer.from("fictional-ssh-server-key");
const credentials = { sftpAddress: "sftp.example.test/incoming", sftpUser: "fixture", sftpPassword: "fictional-secret",
  sftpHostKey: `SHA256:${createHash("sha256").update(serverKey).digest("base64").replace(/=$/, "")}` };
const order = { id: "fixture-order", supplierOrderReference: "fixture-order", deliveryDate: "2026-10-12", accountNumber: "A-1", products: [{ supplierSku: "coffee", qtyPurchaseUnits: 2 }] };

test("SFTP refuses insecure protocols, embedded credentials, relative folders and missing host keys", () => {
  for (const patch of [{ sftpAddress: "ftp://supplier.example.test" }, { sftpAddress: "sftp://user:password@supplier.example.test" },
    { sftpAddress: "sftp.example.test/a/%2e%2e/b" }, { sftpHostKey: "" }, { sftpPort: "invalid" }]) {
    assert.throws(() => resolveSftpConnectionOptions({ ...credentials, ...patch }));
  }
  assert.equal(resolveSftpConnectionOptions(credentials).port, 22);
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "169.254.169.254", "192.168.1.1", "::1", "224.0.0.1"]) assert.equal(publicIpv4(address), false);
  assert.equal(publicIpv4("8.8.8.8"), true);
});

test("SFTP pins DNS and the host key, stages before rename and does not upload an identical existing order", async () => {
  let stored;
  let puts = 0, renames = 0, attempts = 0;
  const client = {
    async connect(options) { assert.equal(options.host, "8.8.8.8"); assert.equal(options.hostVerifier(serverKey), true); assert.equal(options.hostVerifier(Buffer.from("wrong")), false); },
    async exists() { return Boolean(stored); }, async stat() { return { size: stored.length }; }, async get() { return stored; },
    async put(data, path) { puts++; assert.match(path, /\.csv\.pending$/); stored = data; },
    async rename(from, to) { renames++; assert.equal(from, `${to}.pending`); }, async end() {},
  };
  const services = { client, lookup: async () => [{ address: "8.8.8.8" }] };
  const context = { hotelUid: "hotel-a", orderId: "order-a", markExternalAttempt: () => attempts++ };
  const first = await sendOrderBySftp(order, credentials, context, services);
  const second = await sendOrderBySftp(order, credentials, context, services);
  assert.equal(first.remotePath, second.remotePath); assert.equal(second.existing, true);
  assert.equal(puts, 1); assert.equal(renames, 1); assert.equal(attempts, 1);
  await assert.rejects(sendOrderBySftp(order, credentials, context, { ...services, lookup: async () => [{ address: "169.254.169.254" }] }), /public IPv4/);
});

test("public supplier views exclude passwords, usernames and SFTP connection fields", () => {
  const result = supplierPublicView("supplier-a", { name: "Supplier", password: "secret", username: "private", sftpPassword: "secret", sftpUser: "private", notes: "Business note" });
  assert.equal(result.name, "Supplier"); assert.equal(result.credentialsConfigured, true);
  for (const field of ["password", "username", "sftpPassword", "sftpUser"]) assert.equal(result[field], undefined);
});

test("order dates and quantities fail closed and weekday adjustments use UTC calendar dates", () => {
  assert.throws(() => dateOnly("2026-02-30")); assert.throws(() => dateOnly("2026-10-12T00:00:00Z"));
  assert.equal(deliveryDate("2026-10-10", [1]), "2026-10-12");
  assert.equal(cartInput([{ supplierProductId: "p", outletId: "o", qtyPurchaseUnits: 1.001 }])[0].qtyPurchaseUnits, 1.001);
  for (const quantity of [NaN, Infinity, -1, 0, 100001, 0.0001]) assert.throws(() => cartInput([{ supplierProductId: "p", outletId: "o", qtyPurchaseUnits: quantity }]));
  assert.throws(() => cartInput([{ supplierProductId: "p", outletId: "o", qtyPurchaseUnits: 1 }, { supplierProductId: "p", outletId: "o", qtyPurchaseUnits: 2 }]));
});

test("server calls reject unverified email even with a platform administrator claim", () => {
  assert.throws(() => requireVerifiedUser({ auth: { uid: "platform", token: { platformAdmin: true } } }), (error) => error.code === "permission-denied");
  assert.throws(() => requireVerifiedUser({}), (error) => error.code === "unauthenticated");
});

test("the complete Functions entry point loads all SaaS callable exports", () => {
  const functions = require("../index");
  for (const name of ["createHotel", "inviteHotelUser", "listHotelUsers", "saveSupplier", "listSuppliers", "migrateSupplierCredentials",
    "createOrdersFromCart", "confirmHotelOrder", "mutateHotelShoppingCart", "reviewHotelOrderDelivery"]) assert.equal(typeof functions[name], "function");
});
