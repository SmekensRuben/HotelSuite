const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { reviewOrderDeliveryHandler, getHotelOrderDeliveryHandler, deliveryReviewState } = require("./deliveryRecovery");
const { completeDispatch, markDispatchExternalAttempt } = require("./deliveryState");
const { dispatchOrderHandler } = require("./sftpDispatch");
const { processMailQueueHandler } = require("./mailQueue");
const { digest } = require("./validation");
const NOW = 1_800_000_000_000;
const root = "hotels/a", orderPath = `${root}/orders/o`, dispatchPath = `${root}/dispatches/d`;
const auth = { getUser: async (uid) => ({ uid, disabled: false, emailVerified: true, customClaims: {} }) };
const request = (data, uid = "manager") => ({ data, auth: { uid, token: { email_verified: true } } });
function fixture(status = "failed", externalAttempt = false, method = "SFTP csv") {
  const db = memoryDatabase({
    "hotelSubscriptions/a": { status: "active", modules: ["procurement"], modulePolicyVersion: 1 },
    [`${root}/members/manager`]: { permissions: ["orders.read", "orders.recover", "orders.approve"] },
    [`${root}/outlets/bar/approvers/manager`]: {},
    [`${root}/members/original`]: { permissions: ["orders.approve"] }, [`${root}/outlets/bar/approvers/original`]: {},
    [orderPath]: { status: "Created", revision: 1, supplierId: "supplier", dispatchRequestId: "d", dispatchStatus: status },
    [dispatchPath]: { orderId: "o", actorUid: "original", status, externalAttempt, processingAt: NOW - 700000,
      order: { id: "o", outletId: "bar", products: [] }, supplier: { id: "supplier", orderSystem: method } },
    [`${root}/supplierSecrets/supplier`]: { fixture: true },
  });
  return { db, services: { firestore: db, auth, now: () => NOW } };
}
const input = (patch = {}) => ({ hotelUid: "a", orderId: "o", requestId: "recover-once", expectedRevision: 1,
  action: "retry-preparation", source: "configuration-review", evidence: "Sender configuration checked", reason: "Restore failed preparation", ...patch });
const review = (f, patch, uid) => reviewOrderDeliveryHandler(request(input(patch), uid), f.services);
const read = (f, patch = {}, uid) => getHotelOrderDeliveryHandler(request({ hotelUid: "a", orderId: "o", ...patch }, uid), f.services);

test("safe preparation retry keeps the original order snapshot and audits a currently designated replacement actor", async () => {
  const f = fixture(); f.db.records.delete(`${root}/members/original`);
  const original = f.db.records.get(dispatchPath).order;
  const result = await review(f); assert.equal(result.status, "pending");
  assert.equal(f.db.records.get(dispatchPath).status, "superseded");
  const replacement = f.db.records.get(`${root}/dispatches/${result.dispatchId}`);
  assert.deepEqual(replacement.order, original); assert.equal(replacement.actorUid, "manager");
  assert.equal(replacement.externalAttempt, false);
  assert.deepEqual(await review(f), result);
  const history = (await read(f)).events; assert.equal(history.length, 1); assert.equal(history[0].source, "configuration-review"); assert.equal(history[0].reason, "Restore failed preparation");
  await assert.rejects(review(f, { reason: "Changed reason" }), (error) => error.code === "already-exists" && error.details?.deliveryRequestUncommitted !== true);
});

test("findings preserve a known preparation failure without consuming safe retry eligibility", async () => {
  const f = fixture("blocked");
  await review(f, { action: "record-review" });
  const state = await read(f); assert.equal(state.outcome, "preparation-failed"); assert.equal(state.canRetryPreparation, true); assert.equal(state.canRecordReceipt, false);
  await review(f, { expectedRevision: 2, requestId: "retry-after-review" });
  assert.equal((await read(f)).events.length, 2);
});

test("SFTP timeout after a possible send cannot be retried and a verified receipt never transmits again", async () => {
  const f = fixture("pending", false); let sends = 0;
  const event = { params: { hotelUid: "a", orderId: "o" }, data: { before: { exists: true, data: () => ({}) }, after: { exists: true, data: () => f.db.records.get(orderPath) } } };
  const services = { ...f.services, sendSftp: async (_, __, context) => { await context.markExternalAttempt(); sends++; throw new Error("Timeout after supplier may have received file"); } };
  await dispatchOrderHandler(event, services);
  assert.equal(sends, 1); assert.equal(f.db.records.get(dispatchPath).externalAttempt, true); assert.equal(f.db.records.get(dispatchPath).status, "needs-review");
  assert.equal((await read(f)).outcome, "unknown");
  await assert.rejects(review(f), { code: "failed-precondition" });
  await dispatchOrderHandler(event, services); assert.equal(sends, 1);
  const receipt = { action: "record-receipt", source: "sftp-transfer", evidence: "Verified stable order file and transfer log" };
  const first = await review(f, receipt); assert.deepEqual(await review(f, receipt), first);
  await dispatchOrderHandler(event, services); assert.equal(sends, 1);
  assert.equal(f.db.records.get(orderPath).status, "Ordered"); assert.equal((await read(f)).outcome, "transport-accepted");
  assert.equal(f.db.records.get(orderPath).supplierConfirmation, undefined);
  assert.match(f.db.records.get(orderPath).dispatchStep, /supplier acceptance tracked separately/);
  assert.equal(await completeDispatch(f.db, "a", "o", "d", "needs-review", { error: "Late failure" }), false);
  assert.equal(f.db.records.get(orderPath).dispatchStatus, "sent");
});

test("email timeout keeps a durable possible-send marker and synchronized recovery prevents delayed worker overwrites", async () => {
  const f = fixture("queued", false, "Email"), mailId = `order-${digest("o", "d")}`, mailPath = `${root}/mailQueue/${mailId}`;
  f.db.records.set(mailPath, { hotelUid: "a", orderId: "o", dispatchRequestId: "d", status: "queued", type: "order-confirmation", payload: { to: ["supplier@example.test"] } });
  let sends = 0;
  const event = { params: { hotelUid: "a", mailId }, data: { exists: true } };
  const services = { ...f.services, from: "hotel@example.test", send: async () => { sends++; throw new Error("Provider timeout after acceptance"); } };
  await processMailQueueHandler(event, services); await processMailQueueHandler(event, services);
  assert.equal(sends, 1); assert.equal(f.db.records.get(mailPath).externalAttempt, true); assert.equal(f.db.records.get(dispatchPath).status, "needs-review");
  await assert.rejects(review(f), { code: "failed-precondition" });
  await review(f, { action: "record-receipt", source: "email-provider", evidence: "Provider message ID 123" });
  assert.equal(f.db.records.get(mailPath).status, "sent"); assert.equal(f.db.records.get(dispatchPath).status, "sent");
  await processMailQueueHandler(event, services); assert.equal(sends, 1);
});

test("stale evidence registration retires a worker before its external fence and never turns uncertainty into resend authority", async () => {
  const f = fixture("processing", false);
  await review(f, { action: "record-review", source: "supplier-contact", evidence: "Supplier checking receipt; no definitive outcome" });
  assert.equal(await markDispatchExternalAttempt(f.db, "a", "o", "d"), false);
  assert.equal(await completeDispatch(f.db, "a", "o", "d", "sent"), false);
  assert.equal((await read(f)).outcome, "unknown"); assert.equal((await read(f)).canRetryPreparation, false);
});

test("the external fence is durable and exclusive, and a lost fence response cannot become a safe preparation failure", async () => {
  const f = fixture("processing", false);
  const outcomes = await Promise.all([markDispatchExternalAttempt(f.db, "a", "o", "d"), markDispatchExternalAttempt(f.db, "a", "o", "d")]);
  assert.deepEqual(outcomes.sort(), [false, true]);
  await completeDispatch(f.db, "a", "o", "d", "failed", { externalAttempt: false, error: "Fence response lost" });
  assert.equal(f.db.records.get(dispatchPath).status, "needs-review"); assert.equal(f.db.records.get(dispatchPath).externalAttempt, true);
  assert.equal((await read(f)).canRetryPreparation, false);
});

test("concurrent reviewers produce one auditable outcome and an obsolete decision has safe uncommitted proof", async () => {
  const f = fixture("needs-review", true);
  const payload = { action: "record-receipt", source: "sftp-transfer" };
  const outcomes = await Promise.allSettled([review(f, payload), review(f, { ...payload, requestId: "other-review" })]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((result) => result.status === "rejected").reason.details.deliveryRequestUncommitted, true);
  assert.equal((await read(f)).events.length, 1);
});

test("delivery recovery requires explicit current hotel access, separate approval authority and source/reason", async () => {
  for (const permissions of [["orders.*"], ["orders.read", "orders.approve"], ["orders.read", "orders.recover"]]) {
    const f = fixture(); f.db.records.set(`${root}/members/manager`, { permissions });
    await assert.rejects(review(f), { code: "permission-denied" });
  }
  const f = fixture();
  await assert.rejects(review(f, { hotelUid: "b" }), { code: "permission-denied" });
  await assert.rejects(read(f, { hotelUid: "b" }), { code: "permission-denied" });
  await assert.rejects(review(f, { reason: "" }), { code: "invalid-argument" });
  await assert.rejects(review(f, { source: "supplier-contact" }), { code: "invalid-argument" });
  f.db.records.delete(`${root}/outlets/bar/approvers/manager`);
  await assert.rejects(review(f), { code: "permission-denied" });
  const uncertain = fixture("needs-review", true);
  await assert.rejects(review(uncertain, { action: "record-receipt", source: "email-provider" }), { code: "invalid-argument" });
});

test("legacy or recent active attempts fail closed; paginated history cursor cannot cross orders", async () => {
  assert.equal(deliveryReviewState({}, { status: "failed" }).outcome, "unknown");
  assert.equal(deliveryReviewState({}, { status: "processing", processingAt: NOW }, NOW).canRecordReceipt, false);
  const f = fixture(); f.db.records.set(`${root}/orderAudit/other`, { orderId: "different", revision: 2 });
  await assert.rejects(read(f, { afterEventId: "other" }), { code: "invalid-argument" });
});

test("a delayed mail timeout cannot overwrite an operator's receipt recorded while the provider call was running", async () => {
  const f = fixture("queued", false, "Email"), mailId = `order-${digest("o", "d")}`, mailPath = `${root}/mailQueue/${mailId}`;
  f.db.records.set(mailPath, { hotelUid: "a", orderId: "o", dispatchRequestId: "d", status: "queued", type: "order-confirmation", payload: { to: ["supplier@example.test"] } });
  let started, finish; const sending = new Promise((resolve) => { started = resolve; });
  const worker = processMailQueueHandler({ params: { hotelUid: "a", mailId }, data: { exists: true } }, {
    ...f.services, from: "hotel@example.test", send: async () => { started(); return new Promise((_, reject) => { finish = () => reject(new Error("Late timeout")); }); },
  });
  await sending;
  f.db.records.set(dispatchPath, { ...f.db.records.get(dispatchPath), processingAt: NOW - 700000 });
  await review(f, { action: "record-receipt", source: "email-provider", evidence: "Provider confirms original message ID 456" });
  finish(); await worker;
  assert.equal(f.db.records.get(mailPath).status, "sent"); assert.equal(f.db.records.get(dispatchPath).status, "sent");
  assert.equal(f.db.records.get(orderPath).dispatchStatus, "sent"); assert.equal((await read(f)).events.length, 1);
});

test("verified supplier receipt resolves an unknown dispatch without inventing supplier acceptance or resending", async () => {
  const f = fixture("needs-review", true);
  await review(f, { action: "record-receipt", source: "supplier-contact", evidence: "Supplier contact Sam verified receipt of original order o at 14:30; email provider unavailable" });
  const state = await read(f); assert.equal(state.outcome, "receipt-verified"); assert.equal(state.canRetryPreparation, false);
  assert.equal(f.db.records.get(orderPath).supplierConfirmation, undefined);
  assert.equal(f.db.records.get(orderPath).dispatchStep, "Supplier receipt verified; acceptance tracked separately");
  assert.equal(await markDispatchExternalAttempt(f.db, "a", "o", "d"), false);
});
