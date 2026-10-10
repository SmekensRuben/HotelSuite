const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireCurrentVerifiedUser, text } = require("./validation");
const { requireDocumentId, requireHotelSubscription } = require("./subscriptions");
const { normalizedPermissions } = require("./authorization");

async function getHotelUserDisplayNameHandler(request, services = {}) {
  await requireCurrentVerifiedUser(request, services.auth);
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  const userId = text(request.data?.userId, "User identifier", 254, true);
  const db = services.firestore || admin.firestore();
  await requireHotelSubscription(db, hotelUid);
  const caller = await db.doc(`hotels/${hotelUid}/members/${request.auth.uid}`).get();
  if (!caller.exists || !normalizedPermissions(caller.data()?.permissions).length) {
    throw new HttpsError("permission-denied", "Hotel membership and operational access are required.");
  }
  if (userId.includes("/") || [".", ".."].includes(userId)) return { displayName: userId };
  const member = await db.doc(`hotels/${hotelUid}/members/${userId}`).get();
  if (!member.exists) return { displayName: userId };
  // Return only a display name. Never expose email, assignments or global profiles.
  const profile = await db.doc(`users/${userId}`).get();
  const local = member.data();
  const data = Object.hasOwn(local, "firstName") || Object.hasOwn(local, "lastName") ? local : (profile.data() || local);
  const displayName = [data.firstName, data.lastName].filter((value) => typeof value === "string")
    .map((value) => value.trim().slice(0, 80)).filter(Boolean).join(" ") || userId;
  return { displayName };
}

module.exports = { getHotelUserDisplayNameHandler,
  getHotelUserDisplayName: onCall({ region: "us-central1", cors: true }, getHotelUserDisplayNameHandler) };
