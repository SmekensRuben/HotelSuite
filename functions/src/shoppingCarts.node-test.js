const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { mutateShoppingCartHandler } = require("./shoppingCarts");
const { createOrdersFromCartHandler, previewOrdersFromCartHandler } = require("./orders");
const { digest } = require("./validation");

const root = "hotels/hotel-a", cartPath = `${root}/shoppingCarts/cart`;
const row = (outletId = "bar", extra = {}) => ({ supplierProductId: "juice", purchaseOptionId: "default", outletId,
  qtyPurchaseUnits: 5, note: "Chilled", ...extra });
function fixture(items = [row()]) {
  return memoryDatabase({
    [root]: { name: "Hotel A", timeZone: "Europe/Brussels", currency: "EUR" },
    [`${root}/members/buyer-a`]: { permissions: ["orders.create"] },
    [`${root}/members/buyer-b`]: { permissions: ["orders.create"] },
    "hotelSubscriptions/hotel-a": { status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 },
    "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    [`${root}/supplierproducts/juice`]: { supplierId: "vendor", supplierSku: "JUICE", supplierProductName: "Orange juice",
      catalogProductId: "juice", active: true, productPolicyVersion: 1, baseUnit: "l", purchaseUnit: "case",
      baseUnitsPerPurchaseUnit: 6, pricePerPurchaseUnit: 12, currency: "EUR", priceBasis: "net", vatRate: null },
    [`${root}/catalogproducts/juice`]: { name: "Juice", baseUnit: "l", inventoryTracked: true, active: true },
    [`${root}/suppliers/vendor`]: { name: "Vendor" },
    [`${root}/outlets/bar`]: { name: "Bar" }, [`${root}/outlets/kitchen`]: { name: "Kitchen" },
    [cartPath]: { items, revision: 4 },
  });
}
const request = (data, uid = "buyer-a") => ({ auth: { uid, token: { email_verified: true, name: uid } }, data });
const services = (db) => ({ firestore: db, now: () => Date.parse("2026-10-16T12:00:00Z"), auth: { getUser: async () => ({ emailVerified: true, disabled: false }) } });
const command = (db, patch, uid) => mutateShoppingCartHandler(request({ hotelUid: "hotel-a", cartId: "cart", requestId: "change",
  productId: "juice", purchaseOptionId: "default", expectedRevision: 4, ...patch }, uid), services(db));
const submit = (db, patch = {}, uid) => createOrdersFromCartHandler(request({ hotelUid: "hotel-a", shoppingCartId: "cart", requestId: "submit",
  deliveryDate: "2026-10-17", expectedCartRevision: 4, ...patch }, uid), services(db));

test("different outlet lines save independently while a stale edit to the same line is rejected", async () => {
  const db = fixture([row("bar", { lineId: "bar-line", lineRevision: 3 }), row("kitchen", { lineId: "kitchen-line", lineRevision: 7 })]);
  await Promise.all([
    command(db, { action: "quantity", value: 2, lineId: "bar-line", expectedLineRevision: 3, requestId: "bar-change" }),
    command(db, { action: "note", value: "Kitchen only", lineId: "kitchen-line", expectedLineRevision: 7, requestId: "kitchen-change" }, "buyer-b"),
  ]);
  assert.equal(db.records.get(cartPath).revision, 6);
  assert.deepEqual(db.records.get(cartPath).items.map((item) => [item.qtyPurchaseUnits, item.note, item.lineRevision]), [[2, "Chilled", 4], [5, "Kitchen only", 8]]);
  await assert.rejects(command(db, { action: "outlet", value: "kitchen", lineId: "bar-line", expectedLineRevision: 3, requestId: "stale" }),
    (error) => error.code === "aborted" && error.details.cartRequestUncommitted === true && /not been saved/.test(error.message));
  assert.equal(db.records.get(cartPath).items[0].outletId, "bar");
});

test("an atomic split preserves quantities and notes and creates outlet-specific orders without duplicates", async () => {
  const db = fixture();
  const split = { action: "split", value: { quantity: 3, outletId: "kitchen" }, lineId: "legacy-0", expectedLineRevision: 0, requestId: "split" };
  const result = await command(db, split);
  assert.deepEqual(await command(db, split), result);
  const lines = db.records.get(cartPath).items;
  assert.deepEqual(lines.map((item) => [item.outletId, item.qtyPurchaseUnits, item.note]), [["bar", 2, "Chilled"], ["kitchen", 3, "Chilled"]]);
  assert.equal(lines[0].lineId, "legacy-0"); assert.notEqual(lines[0].lineId, lines[1].lineId);
  assert.equal(lines[1].addedBy, "buyer-a"); assert.equal(lines[0].updatedBy, "buyer-a");
  const created = await submit(db, { expectedCartRevision: 5 });
  assert.deepEqual(await submit(db, { expectedCartRevision: 5 }), created);
  await assert.rejects(submit(db, { expectedCartRevision: 5 }, "buyer-b"), (error) => error.code === "aborted" && error.details.orderRequestUncommitted);
  const orders = created.orderIds.map((id) => db.records.get(`${root}/orders/${id}`));
  assert.deepEqual(orders.map((order) => [order.outletId, order.products[0].qtyPurchaseUnits, order.products[0].note, order.totalAmount]), [["bar", 2, "Chilled", 24], ["kitchen", 3, "Chilled", 36]]);
  assert.equal(db.records.get(cartPath).updatedBy, "buyer-a");
  assert.equal([...db.records.keys()].filter((key) => key.startsWith(`${root}/orders/`)).length, 2);
});

test("add merges only the selected outlet and leaves assigned lines untouched when no outlet is selected", async () => {
  const db = fixture([row("bar", { qtyPurchaseUnits: 2 })]);
  await command(db, { action: "add", value: 3, outletId: "kitchen", requestId: "kitchen" });
  await command(db, { action: "add", value: 1, outletId: "kitchen", expectedRevision: 5, requestId: "more-kitchen" });
  await command(db, { action: "add", value: 1, expectedRevision: 6, requestId: "unassigned" });
  assert.deepEqual(db.records.get(cartPath).items.map((item) => [item.outletId, item.qtyPurchaseUnits]), [["bar", 2], ["kitchen", 4], ["", 1]]);
});

test("legacy product-only commands remain usable when unique and reject ambiguous lines", async () => {
  const db = fixture();
  await command(db, { action: "note", value: "Legacy editor" });
  assert.equal(db.records.get(cartPath).items[0].note, "Legacy editor");
  db.records.get(cartPath).items.push(row("kitchen"));
  await assert.rejects(command(db, { action: "remove", expectedRevision: 5, requestId: "ambiguous" }), /multiple cart lines/);
  assert.equal(db.records.get(cartPath).items.length, 2);
});

test("removing a row keeps every remaining legacy identity stable", async () => {
  const db = fixture([row("bar"), row("kitchen")]);
  await command(db, { action: "remove", lineId: "legacy-0", expectedLineRevision: 0 });
  await command(db, { action: "quantity", value: 3, lineId: "legacy-1", expectedLineRevision: 0, requestId: "remaining" });
  assert.deepEqual(db.records.get(cartPath).items.map((item) => [item.lineId, item.outletId, item.qtyPurchaseUnits]), [["legacy-1", "kitchen", 3]]);
});

test("moving or splitting into an existing outlet line never merges away either note", async () => {
  for (const action of ["outlet", "split"]) {
    const db = fixture([row("bar", { note: "Bar note" }), row("kitchen", { note: "Kitchen note" })]);
    const before = structuredClone(db.records.get(cartPath));
    await assert.rejects(command(db, { action, lineId: "legacy-0", expectedLineRevision: 0,
      value: action === "split" ? { quantity: 2, outletId: "kitchen" } : "kitchen" }), /already has a line/);
    assert.deepEqual(db.records.get(cartPath), before);
  }
});

test("line identity, quantity bounds and same-hotel active destinations are enforced", async () => {
  const db = fixture();
  for (const value of [{ quantity: 5, outletId: "kitchen" }, { quantity: 0, outletId: "kitchen" }, { quantity: 0.0001, outletId: "kitchen" }, { quantity: 2, outletId: "bar" }]) {
    await assert.rejects(command(db, { action: "split", value, lineId: "legacy-0", expectedLineRevision: 0 }), { code: "invalid-argument" });
  }
  await assert.rejects(command(db, { action: "quantity", value: 1, lineId: "other-line", expectedLineRevision: 0 }), { code: "not-found" });
  await assert.rejects(command(db, { action: "split", value: { quantity: 2, outletId: "other-hotel-outlet" }, lineId: "legacy-0", expectedLineRevision: 0 }), { code: "not-found" });
  db.records.set(`${root}/outlets/kitchen`, { name: "Kitchen", archived: true });
  await assert.rejects(command(db, { action: "split", value: { quantity: 2, outletId: "kitchen" }, lineId: "legacy-0", expectedLineRevision: 0 }), { code: "not-found" });
  await assert.rejects(command(db, { action: "note", value: "No access", lineId: "legacy-0", expectedLineRevision: 0 }, "outsider"), { code: "permission-denied" });
});

test("same-row concurrent edits have one winner and exact replay does not apply twice", async () => {
  const db = fixture();
  const outcomes = await Promise.allSettled([2, 3].map((value) => command(db, { action: "quantity", value, lineId: "legacy-0", expectedLineRevision: 0, requestId: `qty-${value}` })));
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(db.records.get(cartPath).items[0].qtyPurchaseUnits, 2);
  await command(db, { action: "quantity", value: 2, lineId: "legacy-0", expectedLineRevision: 0, requestId: "qty-2" });
  assert.equal(db.records.get(cartPath).revision, 5);
});

test("a line edit invalidates a reviewed submission and a consumed line cannot be recreated by stale edits", async () => {
  const db = fixture();
  await command(db, { action: "note", value: "Latest", lineId: "legacy-0", expectedLineRevision: 0 });
  await assert.rejects(submit(db), (error) => error.code === "aborted" && error.details.orderRequestUncommitted);
  await submit(db, { expectedCartRevision: 5 });
  await assert.rejects(command(db, { action: "quantity", value: 3, lineId: "legacy-0", expectedLineRevision: 1, requestId: "late" }), { code: "not-found" });
  assert.deepEqual(db.records.get(cartPath).items, []);
});

test("submission binds the reviewed price fingerprint and retains legacy committed receipt replay", async () => {
  const db = fixture();
  const preview = await previewOrdersFromCartHandler(request({ hotelUid: "hotel-a", shoppingCartId: "cart", expectedCartRevision: 4, deliveryDate: "2026-10-17" }), services(db));
  const created = await submit(db, { expectedPriceFingerprint: preview.priceFingerprint });
  await assert.rejects(submit(db, { expectedPriceFingerprint: "different-review" }), { code: "already-exists" });
  const receipt = `${root}/orderOperations/${digest("buyer-a", "submit")}`;
  db.records.set(receipt, { fingerprint: digest("cart", "2026-10-17", 4), result: created });
  assert.deepEqual(await submit(db), created);
});

test("access rejection never claims an uncertain submission was uncommitted", async () => {
  const db = fixture(); await submit(db);
  db.records.delete(`${root}/members/buyer-a`);
  await assert.rejects(submit(db), (error) => error.code === "permission-denied" && error.details?.orderRequestUncommitted !== true);
});
