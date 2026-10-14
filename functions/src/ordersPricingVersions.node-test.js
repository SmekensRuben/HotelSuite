const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { pricingTerms } = require("./supplierPricePolicy");
const { digest } = require("./validation");
const { purchaseTerms } = require("./supplierPriceVersions");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { canonicalLines, createOrdersFromCartHandler, previewOrdersFromCartHandler, updateOrderHandler, confirmOrderHandler } = require("./orders");
const { mutateShoppingCartHandler } = require("./shoppingCarts");

const root = "hotels/hotel-a", actor = "buyer", productId = "juice-case";
const catalog = { name: "Orange juice", baseUnit: "l", inventoryTracked: true, active: true };
const product = (patch = {}) => ({ supplierId: "vendor", supplierSku: "JUICE", supplierProductName: "Orange juice",
  catalogProductId: "juice", active: true, productPolicyVersion: 1, baseUnit: "ml", purchaseUnit: "case",
  baseUnitsPerPurchaseUnit: 6000, pricePerPurchaseUnit: 12, currency: "EUR", priceBasis: "net", vatRate: null,
  purchaseOptions: [{ id: "bottle", purchaseUnit: "bottle", baseUnitsPerPurchaseUnit: 1000, pricePerPurchaseUnit: 3 }],
  priceValidFrom: "2026-01-01", priceValidUntil: "2026-10-31", ...patch });
const input = (option = "default") => ({ supplierProductId: productId, purchaseOptionId: option, outletId: "bar", qtyPurchaseUnits: 2 });
const request = (data, uid = actor) => ({ auth: { uid, token: { email_verified: true, email: "buyer@example.test" } }, data });
const services = (db, date = "2026-10-14T12:00:00Z") => ({ firestore: db, now: () => Date.parse(date), auth: { getUser: async () => ({ emailVerified: true, disabled: false }) } });
function version(price, revision, validFrom, validUntil, extra = {}) {
  const approved = product({ pricePerPurchaseUnit: price, priceValidFrom: validFrom, priceValidUntil: validUntil });
  return { supplierPriceVersionPolicyVersion: 1, supplierProductId: productId, supplierId: "vendor", revision,
    productTerms: purchaseTerms(approved), terms: pricingTerms(approved, catalog), termsFingerprint: digest(pricingTerms(approved, catalog)), sourceIssuedOn: "2026-10-01",
    sourceReference: `Approved list ${revision}.xlsx`, lastPriceChangeAt: { seconds: revision }, lastPriceConfirmedAt: { seconds: revision }, ...extra };
}
function fixture(basis = "order-date") {
  return memoryDatabase({
    [root]: { name: "Hotel A", timeZone: "Europe/Brussels", currency: "EUR" },
    [`${root}/members/${actor}`]: { permissions: ["orders.create", "orders.update", "orders.approve"] },
    "hotelSubscriptions/hotel-a": { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    [`${root}/supplierproducts/${productId}`]: product(), [`${root}/catalogproducts/juice`]: catalog,
    [`${root}/suppliers/vendor`]: { name: "Vendor", priceDateBasis: basis, deliveryDays: [1], orderSystem: "Email", orderEmail: "orders@example.test" },
    [`${root}/outlets/bar`]: { name: "Bar" }, [`${root}/outlets/bar/approvers/${actor}`]: { email: "buyer@example.test" },
    [`${root}/shoppingCarts/cart`]: { items: [input()], revision: 4 },
    [`${root}/supplierPriceVersions/${productId}/entries/0000000000000001`]: version(12, 1, "2026-01-01", "2026-10-31"),
    [`${root}/supplierPriceVersions/${productId}/entries/0000000000000002`]: version(18, 2, "2026-11-01", null),
  });
}
async function makeOrder(db, date = "2026-10-14T12:00:00Z", deliveryDate = "2026-10-31", patch = {}) {
  const result = await createOrdersFromCartHandler(request({ hotelUid: "hotel-a", shoppingCartId: "cart", expectedCartRevision: 4,
    deliveryDate, requestId: "create", ...patch }), services(db, date));
  return { id: result.orderIds[0], order: db.records.get(`${root}/orders/${result.orderIds[0]}`), result };
}
function confirm(db, id, revision = 1, date = "2026-10-14T12:00:00Z") {
  return confirmOrderHandler(request({ hotelUid: "hotel-a", orderId: id, expectedRevision: revision, requestId: "send" }), services(db, date));
}

test("order-date agreements keep the current version despite a later adjusted delivery", async () => {
  const db = fixture(); const { order, result } = await makeOrder(db);
  assert.equal(order.deliveryDate, "2026-11-02"); assert.equal(result.deliveryDateAdjustments[0].resolvedDeliveryDate, "2026-11-02");
  assert.equal(order.totalAmount, 24); assert.equal(order.products[0].supplierPriceVersionId, "0000000000000001");
  assert.equal(order.products[0].pricingDate, "2026-10-14"); assert.equal(order.products[0].priceSourceReference, "Approved list 1.xlsx");
  assert.equal(order.products[0].inventoryTerms.netUnitCost, 2);
});

test("delivery-date agreements choose the future approved version after weekday adjustment", async () => {
  const db = fixture("delivery-date"); const { order } = await makeOrder(db);
  assert.equal(order.deliveryDate, "2026-11-02"); assert.equal(order.products[0].pricingDate, "2026-11-02");
  assert.equal(order.products[0].supplierPriceVersionId, "0000000000000002"); assert.equal(order.totalAmount, 36);
  assert.equal(order.products[0].inventoryTerms.netUnitCost, 3);
  assert.equal(db.records.get(`${root}/supplierproducts/${productId}`).pricePerPurchaseUnit, 12);
});

test("hotel-local order date selects the correct price at midnight without trusting a client date", async () => {
  const db = fixture(); const { order } = await makeOrder(db, "2026-10-31T23:30:00Z", "2026-11-02", { orderDate: "2026-10-31" });
  assert.equal(order.orderDate, "2026-11-01"); assert.equal(order.totalAmount, 36); assert.equal(order.products[0].pricingDate, "2026-11-01");
});

test("expired agreements and explicit date gaps block drafts without emptying the cart", async () => {
  const db = fixture("delivery-date"); db.records.delete(`${root}/supplierPriceVersions/${productId}/entries/0000000000000002`);
  const originalCart = structuredClone(db.records.get(`${root}/shoppingCarts/cart`));
  await assert.rejects(makeOrder(db), (error) => error.code === "failed-precondition" && /expired/.test(error.message));
  assert.deepEqual(db.records.get(`${root}/shoppingCarts/cart`), originalCart);
  assert.equal([...db.records.keys()].filter((key) => key.includes("/orders/")).length, 0);
});

test("unknown validity remains explicit and never becomes a fabricated validity range", async () => {
  const db = fixture(); db.records.delete(`${root}/supplierPriceVersions/${productId}/entries/0000000000000002`);
  db.records.set(`${root}/supplierPriceVersions/${productId}/entries/0000000000000001`, version(12, 1, null, null));
  const { order } = await makeOrder(db); const line = order.products[0];
  assert.equal(line.priceValidity, "unknown"); assert.equal(line.priceNeedsReview, true);
  assert.equal(line.priceValidFrom, null); assert.equal(line.priceValidUntil, null);
});

test("preview is read-only, scoped and enforces current cart revision and access", async () => {
  const db = fixture("delivery-date"), before = structuredClone([...db.records.entries()]);
  const payload = { hotelUid: "hotel-a", shoppingCartId: "cart", expectedCartRevision: 4, deliveryDate: "2026-10-31" };
  const result = await previewOrdersFromCartHandler(request(payload), services(db));
  assert.equal(result.orders[0].totalAmount, 36); assert.equal(result.orders[0].deliveryDate, "2026-11-02");
  assert.equal(result.cartRevision, 4); assert.ok(result.priceFingerprint); assert.deepEqual([...db.records.entries()], before);
  await assert.rejects(previewOrdersFromCartHandler(request({ ...payload, expectedCartRevision: 3 }), services(db)), { code: "aborted" });
  await assert.rejects(previewOrdersFromCartHandler(request({ ...payload, hotelUid: "hotel-b" }), services(db)), { code: "permission-denied" });
  db.records.set(`${root}/members/${actor}`, { permissions: ["orders.read"] });
  await assert.rejects(previewOrdersFromCartHandler(request(payload), services(db)), { code: "permission-denied" });
});

test("a new applicable version after review requires another preview before draft creation", async () => {
  const db = fixture(); const payload = { hotelUid: "hotel-a", shoppingCartId: "cart", expectedCartRevision: 4, deliveryDate: "2026-10-31" };
  const preview = await previewOrdersFromCartHandler(request(payload), services(db));
  db.records.set(`${root}/supplierPriceVersions/${productId}/entries/0000000000000003`, version(16, 3, "2026-10-01", "2026-10-31"));
  await assert.rejects(makeOrder(db, undefined, undefined, { expectedPriceFingerprint: preview.priceFingerprint }), { code: "aborted" });
  assert.equal(db.records.get(`${root}/shoppingCarts/cart`).items.length, 1);
});

test("confirmation rejects an applicability change; explicit draft editing selects the new version", async () => {
  const db = fixture(); const { id } = await makeOrder(db);
  await assert.rejects(confirm(db, id, 1, "2026-11-01T12:00:00Z"), (error) => error.code === "failed-precondition" && /changed/.test(error.message));
  assert.equal(db.records.get(`${root}/orders/${id}`).products[0].pricePerPurchaseUnit, 12);
  await updateOrderHandler(request({ hotelUid: "hotel-a", orderId: id, expectedRevision: 1, payload: { deliveryDate: "2026-11-02" } }), services(db, "2026-11-01T12:00:00Z"));
  assert.equal(db.records.get(`${root}/orders/${id}`).products[0].pricePerPurchaseUnit, 18);
  const result = await confirm(db, id, 2, "2026-11-01T12:00:00Z");
  assert.equal(db.records.get(`${root}/dispatches/${result.dispatchId}`).order.products[0].supplierPriceVersionId, "0000000000000002");
});

test("a confirmation on a later day keeps the reviewed source and terms when the version is unchanged", async () => {
  const db = fixture(); const { id, order } = await makeOrder(db);
  const result = await confirm(db, id, 1, "2026-10-15T12:00:00Z");
  const snapshot = db.records.get(`${root}/dispatches/${result.dispatchId}`).order;
  assert.equal(snapshot.products[0].priceSourceReference, order.products[0].priceSourceReference);
  assert.equal(snapshot.products[0].pricingDate, "2026-10-15"); assert.equal(snapshot.products[0].pricePerPurchaseUnit, 12);
  assert.equal(snapshot.products[0].inventoryTerms.netUnitCost, 2);
});

test("received and finalized snapshots cannot be edited or re-confirmed after later price approvals", async () => {
  for (const status of ["Ordered", "Received", "Finalized"]) {
    const db = fixture(); const { id, order } = await makeOrder(db);
    db.records.set(`${root}/orders/${id}`, { ...order, status }); const before = structuredClone(db.records.get(`${root}/orders/${id}`));
    await assert.rejects(updateOrderHandler(request({ hotelUid: "hotel-a", orderId: id, expectedRevision: 1, payload: { deliveryDate: "2026-11-02" } }), services(db, "2026-11-01T12:00:00Z")), { code: "failed-precondition" });
    await assert.rejects(confirm(db, id, 1, "2026-11-01T12:00:00Z"), { code: "failed-precondition" });
    assert.deepEqual(structuredClone(db.records.get(`${root}/orders/${id}`)), before);
  }
});

test("independent purchase options use their frozen version's terms and keep physical valuations separate", async () => {
  const db = fixture("delivery-date");
  const output = await db.runTransaction((tx) => canonicalLines(db, tx, "hotel-a", [input("default"), input("bottle")], { orderDate: "2026-10-14", deliveryDate: "2026-10-31" }));
  assert.deepEqual(output.lines.map((line) => line.pricePerPurchaseUnit), [18, 3]);
  assert.deepEqual(output.lines.map((line) => line.inventoryTerms.catalogUnitsPerPurchaseUnit), [6, 1]);
});

test("future-only newly listed products can enter the cart as estimates but cannot use a future price early", async () => {
  const db = fixture("delivery-date"); db.records.delete(`${root}/supplierPriceVersions/${productId}/entries/0000000000000001`);
  db.records.set(`${root}/supplierproducts/${productId}`, product({ pricePerPurchaseUnit: null }));
  db.records.set(`${root}/shoppingCarts/cart`, { items: [], revision: 4 });
  await mutateShoppingCartHandler(request({ hotelUid: "hotel-a", cartId: "cart", requestId: "add-future", action: "add", productId,
    value: 1, expectedRevision: 4 }), services(db));
  const row = db.records.get(`${root}/shoppingCarts/cart`).items[0];
  assert.equal(row.pricePerPurchaseUnit, 18); assert.equal(row.priceValidity, "future"); assert.equal(row.indicativePriceVersionId, "0000000000000002");
  await mutateShoppingCartHandler(request({ hotelUid: "hotel-a", cartId: "cart", requestId: "set-outlet", action: "outlet", productId,
    value: "bar", expectedRevision: 5 }), services(db));
  const payload = { hotelUid: "hotel-a", shoppingCartId: "cart", expectedCartRevision: 6, deliveryDate: "2026-10-19" };
  await assert.rejects(previewOrdersFromCartHandler(request(payload), services(db)), (error) => error.code === "failed-precondition" && /future/.test(error.message));
  const preview = await previewOrdersFromCartHandler(request({ ...payload, deliveryDate: "2026-11-02" }), services(db));
  assert.equal(preview.orders[0].totalAmount, 18);
});

test("replayed creation remains idempotent and checks hotel access before returning an old result", async () => {
  const db = fixture(); const first = await makeOrder(db); const repeated = await makeOrder(db);
  assert.equal(first.id, repeated.id); assert.equal([...db.records.keys()].filter((key) => key.startsWith(`${root}/orders/`)).length, 1);
  db.records.delete(`${root}/members/${actor}`);
  await assert.rejects(makeOrder(db), { code: "permission-denied" });
});

test("a future reviewed package configuration can enter a draft cart while legacy flat variants remain guarded", async () => {
  const db = fixture("delivery-date");
  db.records.set(`${root}/supplierproducts/${productId}`, product({ hasVariants: true, purchaseOptions: [] }));
  db.records.set(`${root}/shoppingCarts/cart`, { items: [], revision: 4 });
  await mutateShoppingCartHandler(request({ hotelUid: "hotel-a", cartId: "cart", requestId: "add-reviewed-packages", action: "add", productId,
    value: 1, expectedRevision: 4 }), services(db));
  const saved = db.records.get(`${root}/shoppingCarts/cart`).items[0];
  assert.equal(saved.indicativePriceVersionId, "0000000000000002"); assert.equal(saved.pricePerPurchaseUnit, 18);
  const unreviewed = fixture(); unreviewed.records.set(`${root}/supplierproducts/${productId}`, product({ hasVariants: true, purchaseOptions: [] }));
  for (const path of [...unreviewed.records.keys()]) if (path.includes("/supplierPriceVersions/")) unreviewed.records.delete(path);
  await assert.rejects(mutateShoppingCartHandler(request({ hotelUid: "hotel-a", cartId: "cart", requestId: "add-legacy", action: "add", productId,
    value: 1, expectedRevision: 4 }), services(unreviewed)), (error) => error.code === "failed-precondition" && /Legacy package variants/.test(error.message));
});

test("equal amounts do not hide a different version or a changed price date agreement at confirmation", async () => {
  const db = fixture(); const { id } = await makeOrder(db);
  db.records.set(`${root}/supplierPriceVersions/${productId}/entries/0000000000000003`, version(12, 3, "2026-10-01", "2026-10-31"));
  await assert.rejects(confirm(db, id), (error) => error.code === "failed-precondition" && /changed/.test(error.message));
  db.records.delete(`${root}/supplierPriceVersions/${productId}/entries/0000000000000003`);
  db.records.set(`${root}/suppliers/vendor`, { ...db.records.get(`${root}/suppliers/vendor`), priceDateBasis: "delivery-date" });
  await assert.rejects(confirm(db, id), (error) => error.code === "failed-precondition" && /changed/.test(error.message));
});

test("per-option confirmation evidence does not lend a default package's confirmation to other packages", async () => {
  const db = fixture(); const path = `${root}/supplierPriceVersions/${productId}/entries/0000000000000001`;
  db.records.set(path, { ...db.records.get(path), optionReliability: { default: { lastPriceConfirmedAt: { seconds: 100 }, sourceReference: "Base case list", sourceIssuedOn: "2026-10-01" }, bottle: { lastPriceConfirmedAt: { seconds: 50 }, confirmationMatchesCurrentTerms: false } } });
  const output = await db.runTransaction((tx) => canonicalLines(db, tx, "hotel-a", [input("default"), input("bottle")], { orderDate: "2026-10-14", deliveryDate: "2026-10-19" }));
  assert.equal(output.lines[0].priceNeedsReview, false); assert.equal(output.lines[0].priceConfirmationSourceReference, "Base case list");
  assert.deepEqual(output.lines[1].lastPriceConfirmedAt, { seconds: 50 }); assert.equal(output.lines[1].priceNeedsReview, true);
  assert.equal(output.lines[1].priceConfirmationMatchesCurrentTerms, false);
});
