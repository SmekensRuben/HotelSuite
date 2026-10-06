const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");

function normalizeStrings(values) {
  return Array.isArray(values)
    ? [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
    : [];
}

function normalizeMemberships(hotelUids, memberships) {
  return Object.fromEntries(hotelUids.map((hotelUid) => [
    hotelUid,
    normalizeStrings(memberships?.[hotelUid]),
  ]));
}

async function updateUserAccessHandler(request, services = {}) {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Authentication is required.");
  if (request.auth.token?.platformAdmin !== true) {
    throw new HttpsError("permission-denied", "Platform administrator access is required.");
  }

  const userId = String(request.data?.userId || "").trim();
  if (!userId) throw new HttpsError("invalid-argument", "userId is required.");
  const profile = request.data?.profile && typeof request.data.profile === "object" ? request.data.profile : {};
  const hotelUids = normalizeStrings(profile.hotelUid);
  const previousHotelUids = normalizeStrings(request.data?.previousHotelUids);
  const memberships = normalizeMemberships(hotelUids, request.data?.memberships || {});
  const firestore = services.firestore || admin.firestore();
  const auth = services.auth || admin.auth();
  const batch = firestore.batch();

  batch.update(firestore.doc(`users/${userId}`), {
    firstName: String(profile.firstName || "").trim(),
    lastName: String(profile.lastName || "").trim(),
    email: String(profile.email || "").trim(),
    hotelUid: hotelUids,
    permissions: admin.firestore.FieldValue.delete(),
  });
  hotelUids.forEach((hotelUid) => batch.set(firestore.doc(`hotels/${hotelUid}/members/${userId}`), {
    permissions: memberships[hotelUid],
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true }));
  previousHotelUids.filter((hotelUid) => !hotelUids.includes(hotelUid))
    .forEach((hotelUid) => batch.delete(firestore.doc(`hotels/${hotelUid}/members/${userId}`)));

  await batch.commit();
  const userRecord = await auth.getUser(userId);
  await auth.setCustomUserClaims(userId, {
    ...(userRecord.customClaims || {}),
    hotelPermissions: memberships,
  });
  return { hotelUids, permissionsUpdated: true, tokenRefreshRequired: true };
}

const updateUserAccess = onCall((request) => updateUserAccessHandler(request));

module.exports = { normalizeStrings, normalizeMemberships, updateUserAccessHandler, updateUserAccess };
