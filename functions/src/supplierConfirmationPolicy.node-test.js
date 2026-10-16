require("../testSupport/productionEnvironment").activateProductionTestEnvironment();
const { test } = require("node:test");
const assert = require("node:assert/strict");
const policy = require("./supplierConfirmationPolicy");
const { receiptInventoryLines } = require("./orderReceiving");
const { compileMemberAccess } = require("./modulePolicy");
const { permissionAllows } = require("./authorization");
const { dispatchOrderHandler } = require("./sftpDispatch");
const order = (patch = {}) => ({ status: "Ordered", dispatchStatus: "sent", dispatchRequestId: "sent-once", revision: 2,
  supplierId: "drinks", currency: "EUR", priceBasis: "gross", deliveryDate: "2026-10-14", products: [
    { supplierProductId: "juice", orderLineId: "juice-case", purchaseOptionId: "default", supplierProductName: "Juice case", supplierSku: "J6",
      purchaseUnit: "Case", qtyPurchaseUnits: 10, pricePerPurchaseUnit: 15.9, currency: "EUR", priceBasis: "gross", vatRate: 0.06, netPricePerPurchaseUnit: 15,
      inventoryTerms: { inventoryPolicyVersion: 1, available: true, inventoryTracked: true, catalogProductId: "orange", catalogProductName: "Orange juice",
        catalogBaseUnit: "l", catalogUnitsPerPurchaseUnit: 6, currency: "EUR", netUnitCost: 2.5 } },
    { supplierProductId: "juice", orderLineId: "juice-bottle", purchaseOptionId: "bottle", supplierProductName: "Juice bottle", purchaseUnit: "Bottle",
      qtyPurchaseUnits: 2, pricePerPurchaseUnit: 2.12, currency: "EUR", priceBasis: "gross", vatRate: 0.06, netPricePerPurchaseUnit: 2 },
  ], ...patch });
const response = (patch = {}) => ({ responseType: "accepted", channel: "email", supplierReference: "REF-123", respondedOn: "2026-10-13", note: "",
  lines: order().products.map((line) => ({ supplierProductId: line.supplierProductId, orderLineId: line.orderLineId,
    confirmedQuantity: line.qtyPurchaseUnits, deliveryDate: "2026-10-14", priceMode: "as-ordered", substitute: null, reason: "" })), ...patch });
const fails = (run, code = "invalid-argument") => assert.throws(run, (error) => error.code === code);
const proposal = (patch = {}) => {
  const input = response({ responseType: "changes-proposed" });
  input.lines[0] = { ...input.lines[0], confirmedQuantity: 8, reason: "Two cases unavailable", ...patch };
  return input;
};
test("transport success has no invented supplier acceptance or pricing contract", () => {
  assert.equal(policy.receivingTerms({ response: null }, { lines: [{ acceptedQuantity: 1 }] }), null);
  for (const patch of [{ status: "Created" }, { dispatchStatus: "needs-review" }, { currency: null }, { products: [] }, { articles: [] }]) fails(() => policy.normalizeResponse(response(), order(patch)), "failed-precondition");
});
test("complete acceptance preserves same-SKU purchase options and submitted terms", () => {
  const original = order(), before = structuredClone(original), result = policy.normalizeResponse(response(), original);
  assert.deepEqual(original, before); assert.equal(result.lines.length, 2);
  assert.deepEqual(result.lines.map((line) => [line.orderLineId, line.confirmedQuantity, line.netPricePerPurchaseUnit]), [["juice-bottle", 2, 2], ["juice-case", 10, 15]]);
  assert.deepEqual(policy.normalizeResponse(policy.responseInput(result), original), result);
});
test("shortages, delivery dates and price changes are proposals with explicit reasons", () => {
  for (const patch of [{ confirmedQuantity: 8 }, { confirmedQuantity: 10, deliveryDate: "2026-10-15" },
    { confirmedQuantity: 10, priceMode: "quoted", pricePerPurchaseUnit: 21.2 }, { confirmedQuantity: 10, priceMode: "unknown" }]) {
    const input = proposal(patch), result = policy.normalizeResponse(input, order());
    assert.ok(result.lines.find((line) => line.orderLineId === "juice-case").deviations.length);
    fails(() => policy.normalizeResponse({ ...input, responseType: "accepted" }, order()));
    input.lines[0].reason = ""; fails(() => policy.normalizeResponse(input, order()));
  }
  fails(() => policy.normalizeResponse(response({ responseType: "changes-proposed" }), order()));
});
test("a rejection has a reason and no invented accepted quantities or free prices", () => {
  const rejected = policy.normalizeResponse(response({ responseType: "rejected", note: "No account active", lines: [] }), order());
  assert.deepEqual(rejected.lines, []);
  fails(() => policy.normalizeResponse(response({ responseType: "rejected", lines: [] }), order()));
  fails(() => policy.normalizeReview({ responseId: "one", decision: "accept", reason: "Accept" }, rejected), "failed-precondition");
  assert.equal(policy.normalizeReview({ responseId: "one", decision: "follow-up", reason: "Contact account manager" }, rejected).decision, "follow-up");
});
test("price/identity/currency/VAT injection and incomplete or duplicate responses are rejected", () => {
  for (const field of ["actorUid", "currency", "vatRate", "priceBasis", "netPricePerPurchaseUnit", "catalogProductId", "purchaseOptionId"]) {
    const input = response(); input.lines[0][field] = "spoof"; fails(() => policy.normalizeResponse(input, order()));
  }
  for (const lines of [[], response().lines.slice(0, 1), [response().lines[0], response().lines[0]],
    [{ ...response().lines[0], orderLineId: "foreign" }, response().lines[1]]]) fails(() => policy.normalizeResponse(response({ lines }), order()));
  const input = response(); input.lines[0].pricePerPurchaseUnit = 0; fails(() => policy.normalizeResponse(input, order()));
});
test("unknown and zero remain distinct, and gross VAT is removed exactly once", () => {
  const quoted = policy.normalizeResponse(proposal({ priceMode: "quoted", pricePerPurchaseUnit: 21.2 }), order());
  assert.equal(quoted.lines.find((line) => line.orderLineId === "juice-case").netPricePerPurchaseUnit, 20);
  const terms = policy.receivingTerms({ response: quoted, responseId: "response", review: { decision: "accept" }, reviewId: "review" }, { lines: [{ acceptedQuantity: 1 }] });
  const incoming = [{ supplierProductId: "juice", orderLineId: "juice-case", acceptedQuantity: 2 }];
  const received = receiptInventoryLines(order().products, incoming, terms);
  assert.equal(received.lines[0].quantity, 12); assert.equal(received.lines[0].netValue, 40); assert.equal(received.lines[0].netUnitCost, 3.333333);
  assert.equal(receiptInventoryLines(order().products, incoming).lines[0].netValue, 30);
  for (const price of [0, null]) {
    const input = proposal({ priceMode: price === null ? "unknown" : "quoted", ...(price === null ? {} : { pricePerPurchaseUnit: price }) });
    const changed = policy.normalizeResponse(input, order());
    const result = receiptInventoryLines(order().products, incoming, policy.receivingTerms({ response: changed, responseId: "r", review: { decision: "accept" }, reviewId: "v" }, { lines: [{ acceptedQuantity: 1 }] }));
    assert.equal(result.lines[0].netValue, price === null ? null : 0);
    assert.equal(result.lines[0].netUnitCost, price === null ? null : 0);
  }
});
test("unknown source basis and missing gross VAT do not create net cost", () => {
  for (const patch of [{ priceBasis: "unknown" }, { vatRate: null }]) {
    const source = order(); source.products[0] = { ...source.products[0], ...patch };
    const result = policy.normalizeResponse(proposal({ priceMode: "quoted", pricePerPurchaseUnit: 21.2 }), source);
    assert.equal(result.lines.find((line) => line.orderLineId === "juice-case").netPricePerPurchaseUnit, null);
  }
});
test("a confirmed price never introduces a currency conversion into historical inventory terms", () => {
  const source = order(), confirmed = policy.normalizeResponse(proposal({ priceMode: "quoted", pricePerPurchaseUnit: 21.2 }), source);
  source.products[0].inventoryTerms.currency = "USD";
  const evidence = policy.receivingTerms({ response: confirmed, responseId: "r", review: { decision: "accept" }, reviewId: "v" }, { lines: [{ acceptedQuantity: 1 }] });
  const result = receiptInventoryLines(source.products, [{ supplierProductId: "juice", orderLineId: "juice-case", acceptedQuantity: 2 }], evidence);
  assert.equal(result.lines[0].quantity, 12); assert.equal(result.lines[0].netValue, null); assert.equal(result.lines[0].netUnitCost, null);
});
test("unknown required quantities, text, dates and precision never silently become zero", () => {
  for (const value of [null, undefined, "8", true, NaN, Infinity, -1, 100001, 0.0001]) fails(() => policy.normalizeResponse(proposal({ confirmedQuantity: value }), order()));
  for (const value of [null, undefined, "21", NaN, -1, 1000001, 0.0000001]) fails(() => policy.normalizeResponse(proposal({ priceMode: "quoted", pricePerPurchaseUnit: value }), order()));
  for (const date of ["2026-02-31", "2026-10-13T12:00:00Z", ""]) fails(() => policy.normalizeResponse(response({ respondedOn: date }), order()));
  const unknownDate = policy.normalizeResponse(proposal({ deliveryDate: null }), order());
  assert.equal(unknownDate.lines.find((line) => line.orderLineId === "juice-case").confirmedDeliveryDate, null);
});
test("unreviewed, follow-up and rejected responses cannot authorize accepted goods; rejected-only goods are still traceable", () => {
  const changed = policy.normalizeResponse(proposal(), order());
  for (const review of [null, { decision: "follow-up" }]) fails(() => policy.receivingTerms({ response: changed, review }, { lines: [{ acceptedQuantity: 1 }] }), "failed-precondition");
  assert.equal(policy.receivingTerms({ response: changed, review: null }, { lines: [{ acceptedQuantity: 0 }] }), null);
  const rejected = policy.normalizeResponse(response({ responseType: "rejected", note: "Rejected", lines: [] }), order());
  fails(() => policy.receivingTerms({ response: rejected, review: { decision: "accept" } }, { lines: [{ acceptedQuantity: 1 }] }), "failed-precondition");
});
test("replacement proposals stay proposals and never inherit original stock conversion", () => {
  const changed = policy.normalizeResponse(proposal({ substitute: { description: "Apple juice", supplierSku: "A12", purchaseUnit: "12 bottles" } }), order());
  fails(() => policy.normalizeReview({ responseId: "r", decision: "accept", reason: "Accept" }, changed), "failed-precondition");
  assert.equal(policy.normalizeReview({ responseId: "r", decision: "follow-up", reason: "Request verified replacement order" }, changed).decision, "follow-up");
});
test("physical overdelivery against the supplier's promise requires a reason without changing the submitted order", () => {
  const changed = policy.normalizeResponse(proposal(), order());
  const state = { response: changed, responseId: "response", review: { decision: "accept" }, reviewId: "review" };
  const receipt = { lines: [{ supplierProductId: "juice", orderLineId: "juice-case", acceptedQuantity: 2, reason: "" }] };
  fails(() => policy.receivingTerms(state, receipt, [{ supplierProductId: "juice", orderLineId: "juice-case", acceptedQuantity: 7 }]), "invalid-argument");
  receipt.lines[0].reason = "Physically accepted one extra case";
  assert.equal(policy.receivingTerms(state, receipt, [{ supplierProductId: "juice", orderLineId: "juice-case", acceptedQuantity: 7 }]).lines.find((line) => line.orderLineId === "juice-case").confirmedQuantity, 8);
});
test("event verification detects source changes, tampered prices and cross-order evidence", () => {
  const source = order(), normalized = policy.normalizeResponse(response(), source);
  const event = { policyVersion: 1, kind: "response", hotelUid: "hotel-a", orderId: "one", actorUid: "staff", revision: 3, response: normalized };
  assert.deepEqual(policy.verifiedResponse(event, source, "hotel-a", "one"), normalized);
  const changed = structuredClone(source); changed.products[0].pricePerPurchaseUnit = 99;
  fails(() => policy.verifiedResponse(event, changed, "hotel-a", "one"), "failed-precondition");
  fails(() => policy.verifiedResponse(event, source, "hotel-b", "one"), "failed-precondition");
  const corrupt = structuredClone(event); corrupt.response.lines[0].netPricePerPurchaseUnit = 0;
  fails(() => policy.verifiedResponse(corrupt, source, "hotel-a", "one"), "failed-precondition");
});
test("map-key serialization order cannot make an unchanged source/response stale after export or restore", () => {
  const reverseKeys = (value) => !value || typeof value !== "object" ? value : Array.isArray(value) ? value.map(reverseKeys)
    : Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
  const source = order(), normalized = policy.normalizeResponse(response(), source);
  const event = { policyVersion: 1, kind: "response", hotelUid: "hotel-a", orderId: "one", actorUid: "staff", revision: 3, response: reverseKeys(normalized) };
  assert.deepEqual(policy.verifiedResponse(event, reverseKeys(source), "hotel-a", "one"), normalized);
  assert.equal(policy.stableDigest(source), policy.stableDigest(reverseKeys(source)));
});
test("new optional roles grant explicit confirmation powers without wildcard or legacy role escalation", () => {
  const subscription = { modules: ["procurement"], modulePolicyVersion: 1 };
  assert.ok(compileMemberAccess({ moduleRoles: { procurement: ["supplier-coordinator"] } }, subscription).permissions.includes("orders.recordconfirmation"));
  assert.ok(compileMemberAccess({ moduleRoles: { procurement: ["supplier-response-reviewer"] } }, subscription).permissions.includes("orders.reviewconfirmation"));
  assert.equal(permissionAllows(["orders.*"], "orders", "recordconfirmation"), false);
  assert.equal(permissionAllows(["orders.*"], "orders", "reviewconfirmation"), false);
  for (const role of ["buyer", "approver", "module-manager", "receiver", "receiving-supervisor"]) {
    const access = compileMemberAccess({ hotelAdmin: true, moduleRoles: { procurement: [role] } }, subscription);
    assert.equal(access.permissions.includes("orders.recordconfirmation"), false); assert.equal(access.permissions.includes("orders.reviewconfirmation"), false);
  }
});
test("supplier response and review changes cannot restart an already-sent dispatch", async () => {
  const source = order();
  await dispatchOrderHandler({ params: { hotelUid: "hotel-a", orderId: "one" }, data: { before: { exists: true, data: () => source },
    after: { exists: true, data: () => ({ ...source, supplierConfirmation: { responseType: "accepted" }, revision: 3 }) } } },
  { firestore: { doc: () => { throw new Error("Supplier dispatch must not restart"); } } });
});
