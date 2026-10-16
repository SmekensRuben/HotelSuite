const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, getAppBaseUrl } = require("./config");
const { permissionAllows, normalizedPermissions, requireHotelPermission } = require("./authorization");
const { strictId } = require("./contractFiles");
const { digest } = require("./validation");
const { requireSaasRollout } = require("./saasRollout");
const { requireDocumentId } = require("./subscriptions");
function recipientId(value) {
  const uid = requireDocumentId(value, "recipientUid");
  if (/[\\\u0000-\u001f]/.test(uid)) throw new HttpsError("invalid-argument", "A valid recipient user ID is required.");
  return uid;
}

const eventStatuses = Object.freeze({ submit: "pending", selfapprove: "pending", selfapproved: "approved", approve: "pending", approved: "approved", reject: "rejected", return: "returned" });
const approvalEvents = new Set(["submit", "selfapprove", "approve"]);
const summaryText = (value, max = 200) => String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
function lineSupplier(line, request) {
  const explicit = Object.hasOwn(line || {}, "supplierId"), id = explicit ? summaryText(line.supplierId) : null;
  if (explicit && !id) return null;
  if (line?.supplier?.id && (!explicit || line.supplier.id === id)) return { id: line.supplier.id, name: summaryText(line.supplier.name) };
  if (explicit) return { id, name: "" };
  return request.supplier?.id ? { id: request.supplier.id, name: summaryText(request.supplier.name) } : null;
}
function supplierSummaryLines(request) {
  const lines = Array.isArray(request.lines) ? request.lines.slice(0, 50) : [];
  const suppliers = new Map();
  const candidates = lines.length ? lines.map((line) => lineSupplier(line, request))
    : Array.isArray(request.suppliers) && request.suppliers.length ? request.suppliers.slice(0, 50) : request.supplier ? [request.supplier] : [];
  let unassigned = 0;
  for (const supplier of candidates) {
    if (!supplier?.id) { unassigned += 1; continue; }
    if (!suppliers.has(supplier.id)) suppliers.set(supplier.id, summaryText(supplier.name) || "Supplier details unavailable");
  }
  const names = [...suppliers.values()], label = names.length > 1 ? `Multiple suppliers (${names.length}): ${names.join("; ")}` : names[0] || "Not selected";
  return [`Suppliers: ${label}${unassigned ? `; ${unassigned} ${unassigned === 1 ? "line without a supplier" : "lines without a supplier"}` : ""}`,
    ...(lines.length ? ["", "Purchase lines:", ...lines.map((line, index) => {
      const supplier = lineSupplier(line, request);
      return `${index + 1}. ${summaryText(line.description || line.supplierProductName, 500) || "Purchase line"} — Supplier: ${supplier ? supplier.name || "Supplier details unavailable" : "Not selected"}`;
    })] : [])];
}

function queuePurchaseRequestNotification(tx, { db, hotelUid, requestId, request, event, revision }) {
  if (!Object.hasOwn(eventStatuses, event)) return null;
  const purchaseRequestId = strictId(request.id || request.purchaseRequestId, "purchaseRequestId");
  const recipientUid = recipientId(approvalEvents.has(event) ? request.currentApproverUid : request.requesterUid);
  const mailId = "purchase-request-" + digest(requestId, purchaseRequestId, event, revision, recipientUid);
  tx.create(db.doc(`hotels/${hotelUid}/mailQueue/${mailId}`), {
    type: "purchase-request", hotelUid, purchaseRequestId, revision, event, recipientUid,
    status: "queued", queuedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return mailId;
}

function assignedApproverIsCurrent(request, settings, uid) {
  if (request.currentApproverUid !== uid || request.requesterUid === uid || request.approvals?.some((approval) => approval.approverUid === uid)) return false;
  const step = request.approvalSteps?.[request.currentStepIndex];
  return !!step && Number.isSafeInteger(request.totalMinor) && !!require("./purchaseApprovalRouting").assignmentAuthority(settings || {}, uid, step.id, request.totalMinor, request.costCentreId);
}

// Used within the mail claim transaction, and again just before provider access.
// Every address is rebound to current Auth data instead of a historical email.
async function resolvePurchaseRequestNotification(tx, db, hotelUid, mail, services = {}) {
  try {
    if (mail.hotelUid !== hotelUid || !Object.hasOwn(eventStatuses, mail.event) || !Number.isSafeInteger(mail.revision)) return null;
    const id = strictId(mail.purchaseRequestId, "purchaseRequestId"), uid = recipientId(mail.recipientUid);
    const [requestSnapshot, member, settingsSnapshot, hotel] = await Promise.all([
      tx.get(db.doc(`hotels/${hotelUid}/purchaseRequests/${id}`)), tx.get(db.doc(`hotels/${hotelUid}/members/${uid}`)),
      tx.get(db.doc(`hotels/${hotelUid}/settings/purchaseRequests`)), tx.get(db.doc(`hotels/${hotelUid}`)),
    ]);
    const request = requestSnapshot.data(), permissions = normalizedPermissions(member.data()?.permissions);
    if (!requestSnapshot.exists || request.revision !== mail.revision || request.status !== eventStatuses[mail.event]
      || !member.exists || !permissionAllows(permissions, "purchaserequests", "read")) return null;
    if (approvalEvents.has(mail.event)) {
      if (!permissionAllows(permissions, "purchaserequests", "approve") || !assignedApproverIsCurrent(request, settingsSnapshot.data(), uid)) return null;
    } else if (uid !== request.requesterUid) return null;
    const user = await (services.auth || admin.auth()).getUser(uid);
    if (user.disabled || user.emailVerified !== true || !user.email || user.uid !== undefined && user.uid !== uid) return null;
    const baseUrl = String(services.appBaseUrl || getAppBaseUrl()).replace(/\/$/, "");
    if (!/^https:\/\//.test(baseUrl)) return null;
    const link = `${baseUrl}/purchase-requests/${encodeURIComponent(id)}?hotel=${encodeURIComponent(hotelUid)}`;
    const title = String(request.title || "Purchase request").slice(0, 200);
    const amount = Number.isSafeInteger(request.totalMinor) ? (request.totalMinor / 100).toFixed(2) : "Unavailable";
    const states = { submit: "Awaiting your approval", selfapprove: "Independent approval required", selfapproved: "Self-approved and registered", approve: "Awaiting your approval", approved: "Approved", reject: "Rejected", return: "Returned for changes" };
    const summary = [`${states[mail.event]}: ${title}`, "", `Hotel: ${String(hotel.data()?.hotelName || hotelUid).slice(0, 200)}`,
      `Requester: ${String(request.requesterName || request.requesterUid).slice(0, 200)}`, `Amount: ${amount} ${request.currency || "EUR"} excluding VAT`,
      `Budget month: ${request.budgetMonth || "-"}`, `Budget category: ${request.budgetCategoryName || "-"}`, `Cost centre: ${request.costCentreName || "-"}`,
      ...supplierSummaryLines(request),
      ...(request.selfApproval ? [`Self-approved by: ${summaryText(request.selfApproval.approverName)}; reason: ${summaryText(request.selfApproval.reason, 2000)}`, "Any required independent controls remain separate."] : []),
      ...(request.lastDecisionReason ? [`Decision note: ${String(request.lastDecisionReason).slice(0, 2000)}`] : []),
      "", "Sign in with your own hotel account to view the request and its current approval requirements.", link];
    return { to: [user.email], subject: `${states[mail.event]} — ${title}`, text: summary.join("\n") };
  } catch { return null; }
}

async function retryPurchaseRequestNotificationHandler(request, services = {}) {
  const hotelUid = strictId(request.data?.hotelUid, "hotelUid"), mailId = strictId(request.data?.mailId, "mailId");
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    await requireSaasRollout(db, tx);
    await requireHotelPermission(db, request, hotelUid, "purchaserequests", "read", tx, services.auth);
    const sourceRef = db.doc(`hotels/${hotelUid}/mailQueue/${mailId}`), source = await tx.get(sourceRef);
    const mail = source.data();
    if (!source.exists || mail.type !== "purchase-request" || mail.hotelUid !== hotelUid) throw new HttpsError("not-found", "Purchase request notification not found.");
    const recoveryId = "purchase-request-retry-" + digest(mailId), recoveryRef = db.doc(`hotels/${hotelUid}/mailQueue/${recoveryId}`);
    const [current, recovery] = await Promise.all([tx.get(db.doc(`hotels/${hotelUid}/purchaseRequests/${strictId(mail.purchaseRequestId, "purchaseRequestId")}`)), tx.get(recoveryRef)]);
    if (![current.data()?.requesterUid, current.data()?.currentApproverUid].includes(request.auth.uid)) throw new HttpsError("permission-denied", "Only the current requester or approver can recover this notification.");
    await requireHotelPermission(db, request, hotelUid, "purchaserequests", current.data()?.requesterUid === request.auth.uid ? "update" : "approve", tx, services.auth);
    const payload = await resolvePurchaseRequestNotification(tx, db, hotelUid, mail, services);
    if (!payload) throw new HttpsError("failed-precondition", "This notification no longer matches the current request or recipient authority.");
    if (recovery.exists) return { mailId: recoveryId, status: recovery.data().status };
    if (mail.status !== "failed" || mail.externalAttempt !== false) throw new HttpsError("failed-precondition", "Only a failed notification with no provider attempt can be retried. Ambiguous delivery needs operator review.");
    tx.create(recoveryRef, { type: "purchase-request", hotelUid, purchaseRequestId: mail.purchaseRequestId, revision: mail.revision,
      event: mail.event, recipientUid: mail.recipientUid, status: "queued", recoveredFrom: mailId, queuedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(sourceRef, { recoveredByMailId: recoveryId, recoveredAt: admin.firestore.FieldValue.serverTimestamp() });
    return { mailId: recoveryId, status: "queued" };
  });
}

async function readHotelPurchaseRequestNotificationsHandler(request, services = {}) {
  const hotelUid = strictId(request.data?.hotelUid, "hotelUid"), id = strictId(request.data?.purchaseRequestId, "purchaseRequestId");
  const db = services.firestore || admin.firestore();
  await requireSaasRollout(db);
  await requireHotelPermission(db, request, hotelUid, "purchaserequests", "read", undefined, services.auth);
  const current = await db.doc(`hotels/${hotelUid}/purchaseRequests/${id}`).get();
  if (!current.exists) throw new HttpsError("not-found", "Purchase request not found.");
  const [membership, settings] = await Promise.all([db.doc(`hotels/${hotelUid}/members/${request.auth.uid}`).get(), db.doc(`hotels/${hotelUid}/settings/purchaseRequests`).get()]);
  const permissions = normalizedPermissions(membership.data()?.permissions), value = current.data();
  const actorCanRetry = value.requesterUid === request.auth.uid ? permissionAllows(permissions, "purchaserequests", "update")
    : permissionAllows(permissions, "purchaserequests", "approve") && assignedApproverIsCurrent(value, settings.data(), request.auth.uid);
  const result = await db.collection(`hotels/${hotelUid}/mailQueue`).where("purchaseRequestId", "==", id).where("revision", "==", current.data().revision).limit(101).get();
  const notifications = result.docs.filter((snapshot) => snapshot.data().type === "purchase-request" && snapshot.data().hotelUid === hotelUid)
    .map((snapshot) => {
      const data = snapshot.data();
      return { id: snapshot.id, revision: data.revision, event: data.event, status: data.status,
        canRetry: actorCanRetry && data.status === "failed" && data.externalAttempt === false && data.revision === value.revision
          && eventStatuses[data.event] === value.status && !data.recoveredByMailId,
        ...(data.recoveredByMailId ? { recoveredByMailId: data.recoveredByMailId } : {}) };
    }).sort((a, b) => b.revision - a.revision || a.id.localeCompare(b.id));
  return { notifications: notifications.slice(0, 100), truncated: result.size > 100 };
}

module.exports = { queuePurchaseRequestNotification, assignedApproverIsCurrent, resolvePurchaseRequestNotification, retryPurchaseRequestNotificationHandler, readHotelPurchaseRequestNotificationsHandler,
  readHotelPurchaseRequestNotifications: onCall({ region: "us-central1" }, readHotelPurchaseRequestNotificationsHandler),
  retryPurchaseRequestNotification: onCall({ region: "us-central1" }, retryPurchaseRequestNotificationHandler) };
