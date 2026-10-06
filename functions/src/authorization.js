const { HttpsError } = require("firebase-functions/v2/https");

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

async function requireHotelPermission(db, request, hotelUid, feature, action) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }
  if (request.auth.token?.platformAdmin === true) return;

  const membership = await db.doc(`hotels/${hotelUid}/members/${request.auth.uid}`).get();
  const permissions = normalizedPermissions(membership.exists ? membership.data()?.permissions : []);
  if (!membership.exists || !permissionAllows(permissions, feature, action)) {
    throw new HttpsError("permission-denied", `${feature}.${action} is required for this hotel.`);
  }
}

module.exports = { normalizedPermissions, permissionAllows, requireHotelPermission };
