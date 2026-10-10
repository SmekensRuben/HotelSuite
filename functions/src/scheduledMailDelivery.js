const { createHash } = require("node:crypto");
const { admin } = require("./config");
const { hotelHasActiveSubscription, requireDocumentId, subscriptionIsActive } = require("./subscriptions");
const { permissionAllows, normalizedPermissions } = require("./authorization");

function hotelBusinessDate(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function canonicalForDigest(value) {
  if (value && typeof value.toJSON === "function") return canonicalForDigest(value.toJSON());
  if (Array.isArray(value)) return value.map(canonicalForDigest);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalForDigest(value[key])]));
  }
  return value;
}

function stableDigest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalForDigest(value))).digest("hex");
}

function requireAcknowledgment(response) {
  if (response?.error || typeof response?.data?.id !== "string" || !response.data.id.trim()) {
    const error = new Error("The mail provider did not acknowledge delivery. Reconcile before retrying.");
    error.code = "mail-needs-review";
    throw error;
  }
  return response.data.id;
}

function safeDeliveryError(receiptId) {
  const error = new Error("Mail provider delivery was not acknowledged. Reconcile before retrying.");
  error.code = "mail-needs-review";
  if (receiptId) error.receiptId = receiptId;
  return error;
}

async function acknowledgedSend(send, payload, options) {
  try {
    const response = await send(payload, options);
    requireAcknowledgment(response);
    return response;
  } catch {
    // Transport exceptions can echo recipients or email content. Never retain the original cause.
    throw safeDeliveryError();
  }
}

async function resolveAuthorizedRecipients({ db, auth = admin.auth(), hotelUid, recipientUids, feature, action = "read", transaction }) {
  requireDocumentId(hotelUid, "hotelUid");
  if (!Array.isArray(recipientUids) || recipientUids.length > 20) throw new Error("At most 20 recipient UIDs per hotel are required.");
  const uids = [...new Set(recipientUids.map((uid) => requireDocumentId(uid, "recipientUid")))].sort();
  if (transaction) {
    const subscription = await transaction.get(db.doc(`hotelSubscriptions/${hotelUid}`));
    if (!subscription.exists || !subscriptionIsActive(subscription.data())) return [];
  } else if (!await hotelHasActiveSubscription(db, hotelUid)) return [];
  const recipients = await Promise.all(uids.map(async (uid) => {
    const memberRef = db.doc(`hotels/${hotelUid}/members/${uid}`);
    const member = transaction ? await transaction.get(memberRef) : await memberRef.get();
    if (!member.exists || !permissionAllows(normalizedPermissions(member.data()?.permissions), feature, action)) return null;
    let user;
    try { user = await auth.getUser(uid); }
    catch (error) { if (error.code === "auth/user-not-found") return null; throw error; }
    if (user.disabled || !user.emailVerified || !user.email) return null;
    return user.email;
  }));
  return [...new Set(recipients.filter(Boolean))].sort();
}

function hotelMailFailure(hotelUid, error) {
  const result = { hotelUid, status: "failed", code: error?.code === "mail-needs-review" ? "mail-needs-review" : "hotel-mail-failed" };
  if (typeof error?.receiptId === "string" && /^[a-f0-9]{64}$/.test(error.receiptId)) result.receiptId = error.receiptId;
  return result;
}

function requireNoHotelMailFailures(failures) {
  if (!failures.length) return;
  const error = new Error("Some hotel deliveries were not acknowledged. Reconcile affected hotel journals.");
  error.code = "mail-partial-failure";
  error.hotelFailures = failures;
  throw error;
}

function configuredRecipientUids(configuration, hotelUid) {
  const ids = configuration?.recipientUidsByHotel?.[hotelUid];
  // Historical raw addresses convey no hotel authority and must be migrated explicitly.
  if (!Array.isArray(ids)) throw new Error(`Configure recipientUidsByHotel for hotel ${hotelUid}; raw addresses are no longer accepted.`);
  return ids;
}

async function deliverScheduledMail({ db, hotelUid, deliveryKey, payload, fingerprintData = payload, validateClaim, send, now = Date.now }) {
  requireDocumentId(hotelUid, "hotelUid");
  if (typeof deliveryKey !== "string" || !deliveryKey || deliveryKey.length > 500) throw new Error("A bounded delivery key is required.");
  const id = stableDigest([hotelUid, deliveryKey]);
  const fingerprint = stableDigest(fingerprintData);
  const ref = db.doc(`hotels/${hotelUid}/scheduledMailReceipts/${id}`);
  const previousId = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (snapshot.exists) {
      const previous = snapshot.data();
      if (previous.fingerprint !== fingerprint) throw new Error("This delivery key already identifies another payload. Review before sending.");
      if (previous.status === "sent") {
        try { requireAcknowledgment({ data: { id: previous.providerId } }); return previous.providerId; }
        catch {
          tx.update(ref, { status: "needs-review", error: "Stored provider acknowledgment is invalid. Reconcile before recovery." });
          return { invalidAcknowledgment: true };
        }
      }
      const error = new Error("Delivery is pending or unconfirmed. Reconcile the provider before retrying.");
      error.code = "mail-needs-review";
      throw error;
    }
    if (validateClaim && !await validateClaim(tx)) return { skipped: true };
    tx.create(ref, { hotelUid, deliveryKey, fingerprint, status: "processing", attemptedAt: new Date(now()) });
    return null;
  });
  if (previousId?.invalidAcknowledgment) throw safeDeliveryError(id);
  if (previousId?.skipped) return { skipped: true, status: "source-unavailable" };
  if (previousId) return { data: { id: previousId }, duplicate: true };
  try {
    const response = await acknowledgedSend(send, payload, { idempotencyKey: `hotelsuite/${id}` });
    await ref.update({ status: "sent", providerId: response.data.id, sentAt: new Date(now()) });
    return response;
  } catch {
    // A timeout, rejected response, or lost local acknowledgment cannot prove no message was sent.
    await ref.update({ status: "needs-review", error: "Delivery unconfirmed. Check the provider before recovery.", reviewedAt: new Date(now()) });
    throw safeDeliveryError(id);
  }
}

module.exports = { hotelBusinessDate, stableDigest, requireAcknowledgment, acknowledgedSend, hotelMailFailure, requireNoHotelMailFailures, resolveAuthorizedRecipients, configuredRecipientUids, deliverScheduledMail };
