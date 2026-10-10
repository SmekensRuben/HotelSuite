const { HttpsError } = require("firebase-functions/v2/https");
const { requireDocumentId, requireHotelSubscription } = require("./subscriptions");
const { requireCurrentVerifiedUser } = require("./validation");
const { enforceRequestRollout } = require("./saasRollout");

function normalizedPermissions(value) {
  return Array.isArray(value)
    ? value.map((permission) => String(permission || "").trim().toLowerCase()).filter(Boolean)
    : [];
}

function permissionAllows(permissions, feature, action) {
  const normalizedFeature = String(feature || "").trim().toLowerCase();
  const normalizedAction = String(action || "").trim().toLowerCase();
  return permissions.includes(`${normalizedFeature}.${normalizedAction}`)
    || permissions.includes(`${normalizedFeature}.*`);
}

async function requireHotelPermission(db, request, hotelUid, feature, action, transaction, auth) {
  await requireCurrentVerifiedUser(request, auth);
  await enforceRequestRollout(db, request, transaction);
  hotelUid = requireDocumentId(hotelUid, "hotelUid");
  if (request.auth.token?.platformAdmin === true) return;

  const ref = db.doc(`hotels/${hotelUid}/members/${request.auth.uid}`);
  const membership = transaction ? await transaction.get(ref) : await ref.get();
  const permissions = normalizedPermissions(membership.exists ? membership.data()?.permissions : []);
  if (!membership.exists || !permissionAllows(permissions, feature, action)) {
    throw new HttpsError("permission-denied", `${feature}.${action} is required for this hotel.`);
  }
  await requireHotelSubscription(db, hotelUid, transaction);
}

module.exports = { normalizedPermissions, permissionAllows, requireHotelPermission };
