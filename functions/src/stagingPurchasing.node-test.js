process.env.DEPLOYMENT_ENV = "staging";
process.env.GCLOUD_PROJECT = "hotel-toolkit-staging";
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: "hotel-toolkit-staging", storageBucket: "hotel-toolkit-staging.appspot.com" });
for (const key of ["GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "FUNCTIONS_EMULATOR", "FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "STORAGE_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) delete process.env[key];

const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { pricingTerms } = require("./supplierPricePolicy");
const { purchaseTerms } = require("./supplierPriceVersions");
const { digest } = require("./validation");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { createOrdersFromCartHandler, confirmOrderHandler } = require("./orders");
const { dispatchOrderHandler } = require("./sftpDispatch");
const { processMailQueueHandler } = require("./mailQueue");
const { searchHotelProductsHandler } = require("./productSearch");
const { RESEND_API_KEY, RESEND_FROM, MEILI_HOST, MEILI_API_KEY, MEILI_INDEX } = require("./config");

const actor = "buyer";
const verifiedUser = { emailVerified: true, disabled: false, email: "buyer@example.test", customClaims: {} };
const request = (data, uid = actor) => ({ auth: { uid, token: { email_verified: true, email: "buyer@example.test" } }, data });
function fixture(hotelUid = "ordinary-hotel", supplierId = "ordinary-vendor", method = "Email") {
  const root = `hotels/${hotelUid}`;
  const catalog = { name: "Orange juice", baseUnit: "l", inventoryTracked: true, active: true };
  const product = { supplierId, supplierSku: "JUICE", supplierProductName: "Orange juice", catalogProductId: "juice",
    active: true, productPolicyVersion: 1, baseUnit: "ml", purchaseUnit: "case", baseUnitsPerPurchaseUnit: 6000,
    pricePerPurchaseUnit: 12, currency: "EUR", priceBasis: "net", vatRate: null, priceValidFrom: "2026-01-01", priceValidUntil: "2026-12-31" };
  const db = memoryDatabase({
    [root]: { name: "Fictional hotel", timeZone: "Europe/Brussels", currency: "EUR" },
    [`${root}/members/${actor}`]: { permissions: ["orders.create", "orders.approve", "catalogproducts.read", "supplierproducts.read"] },
    [`hotelSubscriptions/${hotelUid}`]: { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    [`${root}/supplierproducts/juice-case`]: product, [`${root}/catalogproducts/juice`]: catalog,
    [`${root}/suppliers/${supplierId}`]: { name: "Fictional vendor", priceDateBasis: "order-date", orderSystem: method, orderEmail: "orders@example.test" },
    [`${root}/outlets/bar`]: { name: "Bar" }, [`${root}/outlets/bar/approvers/${actor}`]: {},
    [`${root}/shoppingCarts/cart`]: { items: [{ supplierProductId: "juice-case", purchaseOptionId: "default", outletId: "bar", qtyPurchaseUnits: 2 }], revision: 1 },
    [`${root}/supplierPriceVersions/juice-case/entries/0000000000000001`]: {
      supplierPriceVersionPolicyVersion: 1, supplierProductId: "juice-case", supplierId, revision: 1,
      productTerms: purchaseTerms(product), terms: pricingTerms(product, catalog), termsFingerprint: digest(pricingTerms(product, catalog)),
      sourceIssuedOn: "2026-01-01", sourceReference: "Fictional staging price list", lastPriceChangeAt: { seconds: 1 }, lastPriceConfirmedAt: { seconds: 1 },
    },
  });
  return { db, root, hotelUid, supplierId, services: { firestore: db, now: () => Date.parse("2026-10-16T12:00:00Z"), auth: { getUser: async () => ({ ...verifiedUser }) } } };
}
async function draft(f) {
  const result = await createOrdersFromCartHandler(request({ hotelUid: f.hotelUid, shoppingCartId: "cart", expectedCartRevision: 1,
    deliveryDate: "2026-10-19", requestId: "create" }), f.services);
  return result.orderIds[0];
}
const confirm = (f, orderId) => confirmOrderHandler(request({ hotelUid: f.hotelUid, orderId, expectedRevision: 1, requestId: "confirm" }), f.services);
function pendingFixture(method = "Email", status = "pending") {
  const f = fixture("ordinary-hotel", "ordinary-vendor", method);
  f.db.records.set(`${f.root}/orders/order`, { status: "Created", revision: 1, supplierId: f.supplierId, outletId: "bar", dispatchRequestId: "dispatch", dispatchStatus: status });
  f.db.records.set(`${f.root}/dispatches/dispatch`, { orderId: "order", actorUid: actor, status, externalAttempt: false,
    order: { id: "order", outletId: "bar", products: [] }, supplier: { id: f.supplierId, orderSystem: method } });
  return f;
}
const dispatchEvent = (f) => ({ params: { hotelUid: f.hotelUid, orderId: "order" }, data: {
  before: { exists: true, data: () => ({}) }, after: { exists: true, data: () => f.db.records.get(`${f.root}/orders/order`) },
} });
function forbidExternalActions(t, f) {
  const transport = t.mock.fn(() => assert.fail("Staging contacted an external transport."));
  for (const secret of [RESEND_API_KEY, RESEND_FROM, MEILI_HOST, MEILI_API_KEY, MEILI_INDEX]) {
    t.mock.method(secret, "value", () => assert.fail("Staging read a provider secret."));
  }
  const doc = f.db.doc;
  t.mock.method(f.db, "doc", (path) => {
    assert.equal(path.includes("/supplierSecrets/"), false, "Staging must not read SFTP credentials");
    return doc(path);
  });
  Object.assign(f.services, { send: transport, sendSftp: transport, enqueueEmail: transport, search: transport });
  return transport;
}
function queuedMail(f, type = "order-confirmation", patch = {}) {
  f.db.records.set(`${f.root}/mailQueue/mail`, { hotelUid: f.hotelUid, orderId: "order", dispatchRequestId: "dispatch", type,
    status: "queued", payload: { to: ["orders@example.test"], text: "Fictional order" }, ...patch });
  return { params: { hotelUid: f.hotelUid, mailId: "mail" }, data: { exists: true } };
}

test("staging confirmation simulates ordinary email and SFTP suppliers across hotels", async (t) => {
  for (const hotelUid of ["ordinary-hotel", "second-hotel"]) for (const method of ["Email", "SFTP csv"]) {
    const f = fixture(hotelUid, method === "Email" ? "mail-vendor" : "file-vendor", method);
    const transport = forbidExternalActions(t, f), orderId = await draft(f);
    const result = await confirm(f, orderId);
    assert.equal(result.simulated, true); assert.equal(result.environment, "staging");
    const order = f.db.records.get(`${f.root}/orders/${orderId}`), dispatch = f.db.records.get(`${f.root}/dispatches/${result.dispatchId}`);
    assert.equal(order.status, "Ordered"); assert.equal(order.dispatchMode, "simulation"); assert.equal(order.dispatchEnvironment, "staging");
    assert.equal(dispatch.status, "simulated"); assert.equal(dispatch.externalAttempt, false); assert.equal(dispatch.environment, "staging");
    assert.match(order.dispatchStep, /Staging simulation/); assert.equal(transport.mock.callCount(), 0);
    assert.equal([...f.db.records.keys()].some((path) => path.includes("/mailQueue/")), false);
  }
});

test("staging confirmation preserves member, approver and current-account authorization", async () => {
  for (const revoke of [
    (f) => f.db.records.delete(`${f.root}/members/${actor}`),
    (f) => f.db.records.set(`${f.root}/members/${actor}`, { permissions: ["orders.read"] }),
    (f) => f.db.records.delete(`${f.root}/outlets/bar/approvers/${actor}`),
    (f) => { f.services.auth = { getUser: async () => ({ ...verifiedUser, disabled: true }) }; },
  ]) {
    const f = fixture(), orderId = await draft(f); revoke(f);
    await assert.rejects(confirm(f, orderId), { code: "permission-denied" });
    assert.equal(f.db.records.get(`${f.root}/orders/${orderId}`).status, "Created");
    assert.equal([...f.db.records.keys()].some((path) => path.includes("/dispatches/")), false);
  }
});

test("staging confirmation replay retains simulation evidence and rechecks hotel access", async () => {
  const f = fixture(), orderId = await draft(f), first = await confirm(f, orderId);
  assert.deepEqual(await confirm(f, orderId), first);
  assert.equal([...f.db.records.keys()].filter((path) => path.startsWith(`${f.root}/dispatches/`)).length, 1);
  f.db.records.delete(`${f.root}/members/${actor}`);
  await assert.rejects(confirm(f, orderId), { code: "permission-denied" });
});

test("pending email and SFTP workers simulate before private credentials or transport access", async (t) => {
  for (const method of ["Email", "SFTP csv"]) {
    const f = pendingFixture(method), transport = forbidExternalActions(t, f), event = dispatchEvent(f);
    await dispatchOrderHandler(event, f.services); await dispatchOrderHandler(event, f.services);
    const order = f.db.records.get(`${f.root}/orders/order`), dispatch = f.db.records.get(`${f.root}/dispatches/dispatch`);
    assert.equal(order.status, "Ordered"); assert.equal(order.dispatchMode, "simulation"); assert.equal(order.dispatchEnvironment, "staging");
    assert.equal(dispatch.status, "simulated"); assert.equal(dispatch.externalAttempt, false); assert.equal(transport.mock.callCount(), 0);
  }
});

test("staging sender blocks revoked approvers, inactive subscriptions and disabled actors", async (t) => {
  for (const revoke of [
    (f) => f.db.records.delete(`${f.root}/outlets/bar/approvers/${actor}`),
    (f) => { f.db.records.get(`hotelSubscriptions/${f.hotelUid}`).status = "canceled"; },
    (f) => { f.services.auth = { getUser: async () => ({ ...verifiedUser, disabled: true }) }; },
  ]) {
    const f = pendingFixture("SFTP csv"), transport = forbidExternalActions(t, f); revoke(f);
    await dispatchOrderHandler(dispatchEvent(f), f.services);
    assert.equal(f.db.records.get(`${f.root}/dispatches/dispatch`).status, "blocked");
    assert.equal(f.db.records.get(`${f.root}/orders/order`).status, "Created"); assert.equal(transport.mock.callCount(), 0);
  }
});

test("authorized queued order email is simulated once without provider secrets or sends", async (t) => {
  const f = pendingFixture("Email", "queued"), transport = forbidExternalActions(t, f), event = queuedMail(f);
  await processMailQueueHandler(event, f.services); await processMailQueueHandler(event, f.services);
  const mail = f.db.records.get(`${f.root}/mailQueue/mail`), order = f.db.records.get(`${f.root}/orders/order`);
  assert.equal(mail.status, "simulated"); assert.equal(mail.provider, "staging-simulator"); assert.equal(mail.environment, "staging");
  assert.equal(mail.externalAttempt, false); assert.equal(order.status, "Ordered"); assert.equal(order.dispatchMode, "simulation");
  assert.equal(f.db.records.get(`${f.root}/dispatches/dispatch`).status, "simulated"); assert.equal(transport.mock.callCount(), 0);
});

test("staging mail simulation does not bypass current recipient, actor or hotel authorization", async (t) => {
  for (const kind of ["revoked-confirmation", "revoked-approval", "unprivileged-invitation", "foreign-hotel"]) {
    const f = pendingFixture("Email", "queued"), transport = forbidExternalActions(t, f);
    let event;
    if (kind === "revoked-confirmation") {
      event = queuedMail(f); f.db.records.delete(`${f.root}/outlets/bar/approvers/${actor}`);
    } else if (kind === "revoked-approval") {
      event = queuedMail(f, "order-approval", { recipientUids: [actor] });
      f.db.records.set(`${f.root}/members/${actor}`, { permissions: ["orders.read"] });
    } else if (kind === "unprivileged-invitation") {
      event = queuedMail(f, "hotel-invitation", { uid: actor, actorUid: actor, payload: { to: [verifiedUser.email] } });
    } else event = queuedMail(f, "order-confirmation", { hotelUid: "other-hotel" });
    await processMailQueueHandler(event, f.services);
    assert.equal(f.db.records.get(`${f.root}/mailQueue/mail`).status, "blocked", kind);
    assert.equal(f.db.records.get(`${f.root}/mailQueue/mail`).externalAttempt, false, kind);
    assert.equal(transport.mock.callCount(), 0);
  }
});

test("staging catalog search stays in the authorized hotel and paginates filtered canonical rows", async (t) => {
  const f = fixture(), transport = forbidExternalActions(t, f), scans = [];
  for (const id of ["c", "a", "b"]) f.db.records.set(`${f.root}/catalogproducts/coffee-${id}`, { name: `Coffee ${id}`, category: "Drinks", subcategory: "Hot" });
  f.db.records.set(`${f.root}/catalogproducts/wrong-category`, { name: "Coffee elsewhere", category: "Food", subcategory: "Hot" });
  f.db.records.set("hotels/other-hotel/catalogproducts/private", { name: "Private coffee", category: "Drinks", subcategory: "Hot" });
  const collection = f.db.collection;
  t.mock.method(f.db, "collection", (path) => { scans.push(path); return collection(path); });
  const data = { hotelUid: f.hotelUid, collection: "catalogproducts", criteria: { searchTerm: "COFFEE", category: "Drinks", subcategory: "Hot" }, pageSize: 2 };
  const first = await searchHotelProductsHandler(request(data), f.services);
  assert.deepEqual(first.products.map((row) => row.id), ["coffee-a", "coffee-b"]); assert.equal(first.searchMode, "staging-local");
  assert.deepEqual(first.cursor, { offset: 2 }); assert.equal(first.hasMore, true);
  const second = await searchHotelProductsHandler(request({ ...data, offset: first.cursor.offset }), f.services);
  assert.deepEqual(second.products.map((row) => row.id), ["coffee-c"]); assert.equal(second.hasMore, false); assert.equal(second.cursor, null);
  await assert.rejects(searchHotelProductsHandler(request({ ...data, hotelUid: "other-hotel" }), f.services), { code: "permission-denied" });
  assert.deepEqual(scans, [`${f.root}/catalogproducts`, `${f.root}/catalogproducts`]); assert.equal(transport.mock.callCount(), 0);
});

test("staging supplier search applies supplier, active and case-insensitive text filters", async (t) => {
  const f = fixture(), transport = forbidExternalActions(t, f);
  for (const [id, patch] of Object.entries({ one: { active: true }, two: {}, inactive: { active: false }, foreign: { supplierId: "other-vendor" } })) {
    f.db.records.set(`${f.root}/supplierproducts/${id}`, { supplierId: f.supplierId, supplierProductName: "Coffee beans", brand: "Fictional Roastery", ...patch });
  }
  const data = { hotelUid: f.hotelUid, collection: "supplierproducts", criteria: { supplierId: f.supplierId, active: true, searchTerm: "ROASTERY" }, pageSize: 1 };
  const first = await searchHotelProductsHandler(request(data), f.services);
  const second = await searchHotelProductsHandler(request({ ...data, offset: first.cursor.offset }), f.services);
  assert.deepEqual([...first.products, ...second.products].map((row) => row.id), ["one", "two"]); assert.equal(second.hasMore, false);
  const inactive = await searchHotelProductsHandler(request({ ...data, criteria: { ...data.criteria, active: false } }), f.services);
  assert.deepEqual(inactive.products.map((row) => row.id), ["inactive"]); assert.equal(transport.mock.callCount(), 0);
});

test("staging local search permits 1,000 rows and rejects larger collections without partial results", async (t) => {
  const f = fixture(), transport = forbidExternalActions(t, f);
  f.db.records.delete(`${f.root}/catalogproducts/juice`);
  for (let i = 0; i < 1000; i++) f.db.records.set(`${f.root}/catalogproducts/${String(i).padStart(4, "0")}`, { name: `Fictional product ${i}` });
  const data = { hotelUid: f.hotelUid, collection: "catalogproducts", criteria: {}, pageSize: 100, offset: 900 };
  const last = await searchHotelProductsHandler(request(data), f.services);
  assert.equal(last.products.length, 100); assert.equal(last.products[0].id, "0900"); assert.equal(last.hasMore, false);
  f.db.records.set(`${f.root}/catalogproducts/overflow`, { name: "Extra fictional product" });
  await assert.rejects(searchHotelProductsHandler(request(data), f.services), { code: "resource-exhausted" });
  assert.equal(transport.mock.callCount(), 0);
});
