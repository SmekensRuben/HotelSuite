const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");

const SUBSCRIPTION_STATUSES = ["trialing", "active", "suspended", "canceled"];

function requireDocumentId(value, field) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 128
    || /[/]/.test(value) || [".", ".."].includes(value.trim())) {
    throw new HttpsError("invalid-argument", `${field} must be a valid document ID.`);
  }
  return value.trim();
}

function subscriptionIsActive(subscription, now = Date.now()) {
  if (!subscription || !["active", "trialing"].includes(subscription.status)) return false;
  if (subscription.validUntil == null) return subscription.status === "active";
  const expiry = subscription.validUntil?.toMillis?.();
  return Number.isFinite(expiry) && expiry > now;
}

async function requireHotelSubscription(db, hotelUid) {
  const snapshot = await db.doc(`hotelSubscriptions/${hotelUid}`).get();
  if (!snapshot.exists || !subscriptionIsActive(snapshot.data())) {
    throw new HttpsError("permission-denied", "An active hotel subscription is required.");
  }
}

async function hotelHasActiveSubscription(db, hotelUid) {
  const snapshot = await db.doc(`hotelSubscriptions/${requireDocumentId(hotelUid, "hotelUid")}`).get();
  return snapshot.exists && subscriptionIsActive(snapshot.data());
}

async function subscribedHotels(db, hotelUids) {
  const flags = await Promise.all(hotelUids.map((hotelUid) => hotelHasActiveSubscription(db, hotelUid)));
  return hotelUids.filter((hotelUid, index) => flags[index]);
}

function requirePlatformAdministrator(request) {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Authentication is required.");
  if (request.auth.token?.platformAdmin !== true) {
    throw new HttpsError("permission-denied", "Platform administrator access is required.");
  }
}

function subscriptionOverview(subscription) {
  if (!subscription) return null;
  const validUntilMillis = subscription.validUntil == null ? null : subscription.validUntil?.toMillis?.();
  const revision = subscription.revision ?? 0;
  if ((validUntilMillis !== null && !Number.isFinite(validUntilMillis))
    || !Number.isSafeInteger(revision) || revision < 0) {
    throw new HttpsError("failed-precondition", "A subscription record needs operator review.");
  }
  // Return only administration fields, with an explicit timestamp wire format.
  return { status: subscription.status ?? null, planId: subscription.planId ?? null,
    billingMode: subscription.billingMode ?? null, validUntilMillis, revision };
}

async function listHotelSubscriptionsHandler(request, services = {}) {
  requirePlatformAdministrator(request);
  const afterHotelUid = request.data?.afterHotelUid == null ? null
    : requireDocumentId(request.data.afterHotelUid, "afterHotelUid");
  const db = services.firestore || admin.firestore();
  let query = db.collection("hotels").orderBy(admin.firestore.FieldPath.documentId());
  if (afterHotelUid !== null) query = query.startAfter(afterHotelUid);
  const hotels = await query.limit(51).get();
  const page = hotels.docs.slice(0, 50);
  if (!page.length) return { hotels: [], nextCursor: null };
  // Read only subscriptions for this page; orphaned records and audit data are excluded.
  const snapshots = await db.getAll(...page.map((hotel) => db.doc(`hotelSubscriptions/${hotel.id}`)));
  const subscriptions = new Map(snapshots.map((snapshot) => [snapshot.id,
    snapshot.exists ? subscriptionOverview(snapshot.data()) : null]));
  return {
    hotels: page.map((hotel) => ({ hotelUid: hotel.id,
      hotelName: String(hotel.data().hotelName || hotel.data().name || hotel.id).slice(0, 200),
      subscription: subscriptions.get(hotel.id) ?? null })),
    nextCursor: hotels.docs.length > 50 ? page[page.length - 1].id : null,
  };
}

async function setHotelSubscriptionHandler(request, services = {}) {
  requirePlatformAdministrator(request);
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  if (!SUBSCRIPTION_STATUSES.includes(input.status)) throw new HttpsError("invalid-argument", "Invalid subscription status.");
  const planId = String(input.planId || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(planId)) throw new HttpsError("invalid-argument", "planId is required (letters, numbers, hyphens or underscores).");
  const expectedRevision = input.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new HttpsError("invalid-argument", "expectedRevision is required.");
  const expiry = input.validUntil == null || input.validUntil === "" ? null : Date.parse(input.validUntil);
  if (expiry !== null && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.validUntil)
    || !Number.isFinite(expiry) || new Date(expiry).toISOString() !== input.validUntil)) {
    throw new HttpsError("invalid-argument", "validUntil must be an ISO UTC timestamp.");
  }
  if (input.status === "trialing" && expiry === null) throw new HttpsError("invalid-argument", "A trial requires an expiry date.");
  if (["trialing", "active"].includes(input.status) && expiry !== null && expiry <= Date.now()) {
    throw new HttpsError("invalid-argument", "Active subscriptions must expire in the future.");
  }
  const db = services.firestore || admin.firestore();
  const ref = db.doc(`hotelSubscriptions/${hotelUid}`);
  const audit = db.collection(`hotels/${hotelUid}/subscriptionAudit`).doc();
  return db.runTransaction(async (transaction) => {
    const [hotel, current] = await Promise.all([transaction.get(db.doc(`hotels/${hotelUid}`)), transaction.get(ref)]);
    if (!hotel.exists) throw new HttpsError("not-found", "Hotel not found.");
    const previous = current.exists ? current.data() : {};
    if ((previous.revision || 0) !== expectedRevision) throw new HttpsError("aborted", "Subscription changed. Reload before saving.");
    const next = {
      status: input.status, planId, billingMode: "manual",
      validUntil: expiry === null ? null : admin.firestore.Timestamp.fromMillis(expiry),
      revision: expectedRevision + 1,
      updatedBy: request.auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    transaction.set(ref, next);
    transaction.set(audit, {
      actorUid: request.auth.uid,
      previousStatus: previous.status || null,
      status: next.status, planId, validUntil: next.validUntil, revision: next.revision,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { hotelUid, revision: next.revision };
  });
}

const setHotelSubscription = onCall({ region: "us-central1", cors: true }, setHotelSubscriptionHandler);
const listHotelSubscriptions = onCall({ region: "us-central1", cors: true }, listHotelSubscriptionsHandler);
module.exports = { requireDocumentId, subscriptionIsActive, requireHotelSubscription, hotelHasActiveSubscription, subscribedHotels, setHotelSubscriptionHandler, setHotelSubscription, listHotelSubscriptionsHandler, listHotelSubscriptions };
