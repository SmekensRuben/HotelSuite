const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryDatabase } = require("./inventoryTestHelpers");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { queuePurchaseRequestNotification, assignedApproverIsCurrent, resolvePurchaseRequestNotification, retryPurchaseRequestNotificationHandler,
  readHotelPurchaseRequestNotificationsHandler } = require("./purchaseRequestNotifications");
const { processMailQueueHandler } = require("./mailQueue");

const hotelUid = "hotel-a", id = "request-a", requestPath = `hotels/${hotelUid}/purchaseRequests/${id}`;
const request = () => ({ id, purchaseRequestId: id, hotelUid, revision: 2, status: "pending", title: "Repair the freezer", requesterUid: "requester", requesterName: "Requester",
  supplier: { id: "supplier", name: "Repairs" }, totalMinor: 12500, currency: "EUR", budgetMonth: "2026-10", budgetCategoryName: "Maintenance", costCentreName: "Kitchen",
  approvalSteps: [{ id: "manager", name: "Manager" }], approvals: [], currentStepIndex: 0, currentApproverUid: "approver" });
const envelope = (patch = {}) => ({ type: "purchase-request", hotelUid, purchaseRequestId: id, revision: 2, event: "submit", recipientUid: "approver", status: "queued", ...patch });
function fixture(extra = {}) {
  const db = memoryDatabase({ "platformConfiguration/saasProcurement": { enabled: true, rulesVersion: SAAS_RULES_VERSION },
    [`hotelSubscriptions/${hotelUid}`]: { status: "active", modules: ["procurement"], modulePolicyVersion: 1 },
    [`hotels/${hotelUid}`]: { hotelName: "Hotel A" }, [requestPath]: request(),
    [`hotels/${hotelUid}/members/requester`]: { permissions: ["purchaserequests.read", "purchaserequests.update"] },
    [`hotels/${hotelUid}/members/approver`]: { permissions: ["purchaserequests.read", "purchaserequests.approve"] },
    [`hotels/${hotelUid}/settings/purchaseRequests`]: { approvalSteps: [{ id: "manager" }], approvers: [{ uid: "approver", stepIds: ["manager"], limitMinor: 50000, canApproveOverBudget: false }] }, ...extra });
  const originalDoc = db.doc;
  db.doc = (path) => ({ ...originalDoc(path), update: async (data) => db.runTransaction(async (tx) => { tx.update(originalDoc(path), data); }) });
  const users = { requester: { uid: "requester", email: "requester@example.test", emailVerified: true, disabled: false }, approver: { uid: "approver", email: "current@example.test", emailVerified: true, disabled: false } };
  const sent = [], auth = { getUser: async (uid) => { if (!users[uid]) throw new Error("missing"); return users[uid]; } };
  const services = { firestore: db, auth, appBaseUrl: "https://hotel.example.test", from: "app@example.test", send: async (payload, options) => { sent.push({ payload, options }); return { data: { id: "provider-id" } }; } };
  return { db, users, sent, services };
}
const actor = (data, uid = "requester") => ({ auth: { uid, token: { email_verified: true, auth_time: 100 } }, data: { hotelUid, ...data } });
const resolve = (f, mail = envelope()) => f.db.runTransaction((tx) => resolvePurchaseRequestNotification(tx, f.db, hotelUid, mail, f.services));
const process = (f, mail = envelope(), mailId = "mail-a") => {
  if (!f.db.records.has(`hotels/${hotelUid}/mailQueue/${mailId}`)) f.db.records.set(`hotels/${hotelUid}/mailQueue/${mailId}`, mail);
  return processMailQueueHandler({ params: { hotelUid, mailId }, data: { exists: true } }, f.services);
};

test("core transition queue IDs are deterministic and only required events generate notifications", async () => {
  const f = fixture(), target = request(); let first;
  await f.db.runTransaction(async (tx) => { first = queuePurchaseRequestNotification(tx, { db: f.db, hotelUid, requestId: "command", request: target, event: "submit", revision: 2 }); });
  assert.match(first, /^purchase-request-[a-f0-9]{64}$/);
  const row = f.db.records.get(`hotels/${hotelUid}/mailQueue/${first}`);
  assert.equal(row.recipientUid, "approver"); assert.equal(row.payload, undefined);
  assert.equal(queuePurchaseRequestNotification({}, { event: "save" }), null);
  let noWrites = 0;
  assert.equal(queuePurchaseRequestNotification({ create: () => { noWrites += 1; } }, { db: f.db, hotelUid, requestId: "command", request: target, event: "submit", revision: 2 }), first);
  assert.equal(noWrites, 1);
});

test("mail summaries bind current verified email and a hotel-aware application link without attachments", async () => {
  const f = fixture(), payload = await resolve(f);
  assert.deepEqual(payload.to, ["current@example.test"]); assert.equal(payload.attachments, undefined);
  assert.match(payload.text, /125\.00 EUR excluding VAT/);
  assert.match(payload.text, /https:\/\/hotel\.example\.test\/purchase-requests\/request-a\?hotel=hotel-a/);
  assert.match(payload.text, /Cost centre: Kitchen/);
  assert.equal(await resolve(f, envelope({ hotelUid: "hotel-b" })), null);
});

test("mixed-supplier notifications use saved supplier identities per line without mutable supplier data", async () => {
  const f = fixture(), current = f.db.records.get(requestPath);
  current.supplier = null; current.supplierId = "";
  current.lines = [
    { description: "Dinner plates", supplierId: "wholesaler", supplier: { id: "wholesaler", name: "Saved Wholesaler" } },
    { description: "Repair\nvisit", supplierId: "repairs", supplier: { id: "repairs", name: "Local Repairs", privateNote: "Do not disclose" } },
    { description: "Extra plates", supplierId: "wholesaler", supplier: { id: "wholesaler", name: "Saved Wholesaler" } },
  ];
  f.db.records.set(`hotels/${hotelUid}/suppliers/wholesaler`, { name: "Renamed live supplier", privateNote: "Private supplier details" });
  const payload = await resolve(f);
  assert.match(payload.text, /Suppliers: Multiple suppliers \(2\): Saved Wholesaler; Local Repairs/);
  assert.match(payload.text, /1\. Dinner plates — Supplier: Saved Wholesaler/);
  assert.match(payload.text, /2\. Repair visit — Supplier: Local Repairs/);
  assert.match(payload.text, /3\. Extra plates — Supplier: Saved Wholesaler/);
  assert.ok(!/Renamed live|Do not disclose|Private supplier/.test(payload.text));
  assert.deepEqual(payload.to, ["current@example.test"]);
  await process(f); await process(f);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].payload.text, payload.text);
  assert.match(f.sent[0].options.idempotencyKey, /^hotelsuite\//);
});

test("notification supplier fallback distinguishes legacy absent IDs from deliberately blank line suppliers", async () => {
  const f = fixture(), current = f.db.records.get(requestPath);
  current.lines = [{ description: "Legacy repair" }, { description: "Unassigned quote", supplierId: "", supplier: { id: "supplier", name: "Must not inherit" } },
    { description: "Incomplete snapshot", supplierId: "other", supplier: current.supplier }];
  const payload = await resolve(f);
  assert.match(payload.text, /1\. Legacy repair — Supplier: Repairs/);
  assert.match(payload.text, /2\. Unassigned quote — Supplier: Not selected/);
  assert.match(payload.text, /3\. Incomplete snapshot — Supplier: Supplier details unavailable/);
  assert.match(payload.text, /1 line without a supplier/);
  assert.ok(!payload.text.includes("Must not inherit"));
});

test("supplier notification summaries stay bounded to the maximum fifty purchase lines", async () => {
  const f = fixture();
  f.db.records.get(requestPath).lines = Array.from({ length: 51 }, (_, index) => ({ description: `Item ${index + 1}`, supplierId: "supplier", supplier: { id: "supplier", name: "Saved supplier" } }));
  const payload = await resolve(f);
  assert.match(payload.text, /50\. Item 50 — Supplier: Saved supplier/);
  assert.ok(!payload.text.includes("Item 51"));
});

test("notification recipients preserve valid non-autogenerated Firebase user IDs", async () => {
  const f = fixture(), uid = "staff.manager+approval@example.test";
  f.db.records.get(requestPath).currentApproverUid = uid;
  f.db.records.set(`hotels/${hotelUid}/members/${uid}`, { permissions: ["purchaserequests.read", "purchaserequests.approve"] });
  f.db.records.get(`hotels/${hotelUid}/settings/purchaseRequests`).approvers[0].uid = uid;
  f.users[uid] = { ...f.users.approver, uid };
  assert.deepEqual((await resolve(f, envelope({ recipientUid: uid }))).to, ["current@example.test"]);
  await f.db.runTransaction(async (tx) => queuePurchaseRequestNotification(tx, { db: f.db, hotelUid, requestId: "custom-uid", request: f.db.records.get(requestPath), event: "submit", revision: 2 }));
});

test("current approval authority rejects self, repeated, under-limit, removed and unauthorized over-budget recipients", async () => {
  const f = fixture(), current = request(), settings = f.db.records.get(`hotels/${hotelUid}/settings/purchaseRequests`);
  assert.equal(assignedApproverIsCurrent(current, settings, "approver"), true);
  for (const mutate of [() => { current.requesterUid = "approver"; }, () => { current.approvals = [{ approverUid: "approver" }]; },
    () => { settings.approvers[0].limitMinor = 100; }, () => { settings.approvers[0].stepIds = []; }, () => { settings.approvalSteps = []; },
    () => { current.approvalSteps = [{ id: "over-budget" }]; }]) {
    const isolated = request(), authority = structuredClone(f.db.records.get(`hotels/${hotelUid}/settings/purchaseRequests`));
    Object.assign(current, isolated); Object.assign(settings, authority); mutate();
    assert.equal(assignedApproverIsCurrent(current, settings, "approver"), false);
    Object.assign(current, request()); Object.assign(settings, { approvalSteps: [{ id: "manager" }], approvers: [{ uid: "approver", stepIds: ["manager"], limitMinor: 50000, canApproveOverBudget: false }] });
  }
  current.approvalSteps = [{ id: "over-budget" }]; settings.approvers[0].canApproveOverBudget = true;
  assert.equal(assignedApproverIsCurrent(current, settings, "approver"), true);
});

test("stale request revision, step reassignment, membership removal and disabled or unverified accounts block email", async () => {
  for (const change of ["revision", "assignee", "membership", "permission", "disabled", "unverified", "status", "limit"]) {
    const f = fixture();
    if (change === "revision") f.db.records.get(requestPath).revision += 1;
    if (change === "assignee") f.db.records.get(requestPath).currentApproverUid = "someone-else";
    if (change === "membership") f.db.records.delete(`hotels/${hotelUid}/members/approver`);
    if (change === "permission") f.db.records.get(`hotels/${hotelUid}/members/approver`).permissions = ["purchaserequests.read"];
    if (change === "disabled") f.users.approver.disabled = true;
    if (change === "unverified") f.users.approver.emailVerified = false;
    if (change === "status") f.db.records.get(requestPath).status = "withdrawn";
    if (change === "limit") f.db.records.get(`hotels/${hotelUid}/settings/purchaseRequests`).approvers[0].limitMinor = 5;
    await process(f);
    assert.equal(f.sent.length, 0, change); assert.equal(f.db.records.get(`hotels/${hotelUid}/mailQueue/mail-a`).status, "blocked", change);
  }
});

test("requester outcomes send only to current requester with request read access", async () => {
  for (const [event, status] of [["approved", "approved"], ["reject", "rejected"], ["return", "returned"]]) {
    const f = fixture(); f.db.records.get(requestPath).status = status;
    const mail = envelope({ event, recipientUid: "requester" });
    const payload = await resolve(f, mail); assert.deepEqual(payload.to, ["requester@example.test"]);
    assert.equal(await resolve(f, { ...mail, recipientUid: "approver" }), null);
    f.db.records.get(`hotels/${hotelUid}/members/requester`).permissions = [];
    assert.equal(await resolve(f, mail), null);
  }
});

test("mail worker sends one current notification with provider idempotency and rechecks before transport", async () => {
  const f = fixture(); await process(f); await process(f);
  assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0].payload.to, ["current@example.test"]);
  assert.match(f.sent[0].options.idempotencyKey, /^hotelsuite\//);
  assert.equal(f.db.records.get(`hotels/${hotelUid}/mailQueue/mail-a`).status, "sent");
  const revoked = fixture(); let checks = 0;
  revoked.services.auth.getUser = async (uid) => { checks += 1; return { ...revoked.users[uid], disabled: checks >= 2 }; };
  await process(revoked); assert.equal(revoked.sent.length, 0); assert.equal(revoked.db.records.get(`hotels/${hotelUid}/mailQueue/mail-a`).status, "blocked");
});

test("module or subscription loss prevents notification delivery", async () => {
  for (const patch of [{ status: "suspended" }, { status: "active", modules: ["core"] }]) {
    const f = fixture(); Object.assign(f.db.records.get(`hotelSubscriptions/${hotelUid}`), patch);
    await process(f); assert.equal(f.sent.length, 0); assert.equal(f.db.records.get(`hotels/${hotelUid}/mailQueue/mail-a`).status, "blocked");
  }
});

test("safe notification projection excludes provider details, payloads, historical emails and other hotels", async () => {
  const f = fixture({ [`hotels/${hotelUid}/mailQueue/failed`]: envelope({ status: "failed", externalAttempt: false, payload: { to: ["private@example.test"], text: "private" }, providerId: "private-provider" }),
    [`hotels/${hotelUid}/mailQueue/old`]: envelope({ revision: 1 }), "hotels/hotel-b/mailQueue/other": envelope({ hotelUid: "hotel-b" }) });
  const result = await readHotelPurchaseRequestNotificationsHandler(actor({ purchaseRequestId: id }), f.services);
  assert.deepEqual(result.notifications, [{ id: "failed", revision: 2, event: "submit", status: "failed", canRetry: true }]);
  assert.ok(!JSON.stringify(result).includes("private"));
  await assert.rejects(readHotelPurchaseRequestNotificationsHandler(actor({ hotelUid: "hotel-b", purchaseRequestId: id }), f.services), (error) => error.code === "permission-denied");
});

test("only provably unattempted failures recover, concurrent recovery retains one deterministic queue entry", async () => {
  const f = fixture({ [`hotels/${hotelUid}/mailQueue/failed`]: envelope({ status: "failed", externalAttempt: false }) });
  const results = await Promise.all([retryPurchaseRequestNotificationHandler(actor({ mailId: "failed" }), f.services), retryPurchaseRequestNotificationHandler(actor({ mailId: "failed" }), f.services)]);
  assert.equal(results[0].mailId, results[1].mailId);
  assert.equal([...f.db.records.keys()].filter((path) => path.includes("/mailQueue/purchase-request-retry-")).length, 1);
  await process(f, null, results[0].mailId); assert.equal(f.sent.length, 1);
});

test("missing email configuration records no external attempt and can be recovered after configuration is fixed", async () => {
  const original = global.process.env.RESEND_FROM;
  global.process.env.RESEND_FROM = "";
  try {
    const f = fixture(); f.services.from = "";
    await process(f);
    assert.equal(f.sent.length, 0);
    assert.equal(f.db.records.get(`hotels/${hotelUid}/mailQueue/mail-a`).status, "failed");
    assert.equal(f.db.records.get(`hotels/${hotelUid}/mailQueue/mail-a`).externalAttempt, false);
    f.services.from = "app@example.test";
    const recovery = await retryPurchaseRequestNotificationHandler(actor({ mailId: "mail-a" }), f.services);
    await process(f, null, recovery.mailId);
    assert.equal(f.sent.length, 1);
  } finally { if (original === undefined) delete global.process.env.RESEND_FROM; else global.process.env.RESEND_FROM = original; }
});

test("recovery rejects ambiguous provider outcomes, stale requests, foreign hotel and revoked requester rights", async () => {
  for (const [status, externalAttempt] of [["needs-review", true], ["processing", undefined], ["sent", true], ["failed", undefined], ["failed", true]]) {
    const f = fixture({ [`hotels/${hotelUid}/mailQueue/failed`]: envelope({ status, ...(externalAttempt !== undefined ? { externalAttempt } : {}) }) });
    await assert.rejects(retryPurchaseRequestNotificationHandler(actor({ mailId: "failed" }), f.services), (error) => error.code === "failed-precondition");
  }
  const f = fixture({ [`hotels/${hotelUid}/mailQueue/failed`]: envelope({ status: "failed", externalAttempt: false }) });
  f.db.records.get(requestPath).revision += 1;
  await assert.rejects(retryPurchaseRequestNotificationHandler(actor({ mailId: "failed" }), f.services), (error) => error.code === "failed-precondition");
  await assert.rejects(retryPurchaseRequestNotificationHandler(actor({ hotelUid: "hotel-b", mailId: "failed" }), f.services), (error) => error.code === "permission-denied");
  f.db.records.get(requestPath).revision = 2; f.db.records.get(`hotels/${hotelUid}/members/requester`).permissions = ["purchaserequests.read"];
  await assert.rejects(retryPurchaseRequestNotificationHandler(actor({ mailId: "failed" }), f.services), (error) => error.code === "permission-denied");
});

test("an unacknowledged provider attempt remains needs-review and cannot be retried automatically", async () => {
  const f = fixture(); f.services.send = async () => ({ error: { message: "private provider data" } });
  await process(f);
  const current = f.db.records.get(`hotels/${hotelUid}/mailQueue/mail-a`);
  assert.equal(current.status, "needs-review"); assert.equal(current.externalAttempt, true); assert.ok(!current.error.includes("private"));
  await assert.rejects(retryPurchaseRequestNotificationHandler(actor({ mailId: "mail-a" }), f.services), (error) => error.code === "failed-precondition");
});
