const { HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireHotelPermission, normalizedPermissions, permissionAllows } = require("./authorization");
const { requireCurrentVerifiedUser } = require("./validation");
const { requireDocumentId, subscriptionIsActive } = require("./subscriptions");
const { moduleAllows } = require("./modulePolicy");
const { requireSaasRollout } = require("./saasRollout");

const READ_SCOPE = "hotel-toolkit:read";
const PROPOSE_SCOPE = "hotel-toolkit:propose";
const PRODUCT_FEATURES = ["catalogproducts", "supplierproducts"];
const REFERENCE_FEATURES = ["suppliers", "catalogsettings"];

// This context is constructed by the verified HTTP bearer boundary, never from
// tool arguments. Native Firebase review calls use the same hotel authorization.
async function requireMcpScope(request, scope) {
  if (request.mcpAuth === undefined) return;
  const grant = request.mcpAuth;
  if (!grant || !Array.isArray(grant.scopes) || !grant.scopes.includes(scope)
    || typeof grant.assertActive !== "function") {
    throw new HttpsError("permission-denied", "This personal connection has not been authorized for this action.", { requiredMcpScope: scope });
  }
  await grant.assertActive();
}

async function requireMcpHotelPermission(db, request, hotelUid, feature, action, transaction, services = {}) {
  if (!(PRODUCT_FEATURES.includes(feature) && ["read", "create", "update"].includes(action))
    && !(REFERENCE_FEATURES.includes(feature) && action === "read")) {
    throw new HttpsError("permission-denied", "This domain action is not available through the product connection.");
  }
  await requireMcpScope(request, action === "read" ? READ_SCOPE : PROPOSE_SCOPE);
  await requireSaasRollout(db, transaction);
  await requireHotelPermission(db, request, hotelUid, feature, action, transaction, services.auth);
  return { uid: request.auth.uid, hotelUid };
}

async function discoverMcpHotelsHandler(request, services = {}) {
  const input = request.data || {};
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) {
    throw new HttpsError("invalid-argument", "Hotel discovery does not accept a destination or user ID.");
  }
  await requireMcpScope(request, READ_SCOPE);
  await requireCurrentVerifiedUser(request, services.auth);
  const db = services.firestore || admin.firestore();
  await requireSaasRollout(db);
  const profile = await db.doc(`users/${request.auth.uid}`).get();
  const assignments = profile.exists ? profile.data().hotelUid ?? [] : [];
  if (!Array.isArray(assignments) || assignments.length > 50) {
    throw new HttpsError("failed-precondition", "Your hotel assignments need review in Hotel Toolkit.");
  }
  const hotelUids = [...new Set(assignments.map((value) => requireDocumentId(value, "Assigned hotel")))].sort();
  const hotels = [];
  // The private profile supplies candidate IDs. Current membership and license
  // are authoritative; platform claims never cause a global hotel query.
  for (const hotelUid of hotelUids) {
    const member = await db.doc(`hotels/${hotelUid}/members/${request.auth.uid}`).get();
    if (!member.exists) continue;
    const permissions = normalizedPermissions(member.data().permissions);
    // Staging requires read access to compare existing values and expose the
    // resulting review. Do not advertise a blind write-only workflow.
    const actions = (feature) => permissionAllows(permissions, feature, "read")
      ? ["read", "create", "update"].filter((action) => permissionAllows(permissions, feature, action)) : [];
    const catalog = actions("catalogproducts"), supplier = actions("supplierproducts");
    if (!catalog.length && !supplier.length) continue;
    const subscription = await db.doc(`hotelSubscriptions/${hotelUid}`).get();
    if (!subscription.exists || !subscriptionIsActive(subscription.data()) || !moduleAllows(subscription.data(), "procurement")) continue;
    const hotel = await db.doc(`hotels/${hotelUid}`).get();
    if (!hotel.exists) continue;
    hotels.push({
      hotelUid,
      name: String(hotel.data().hotelName || hotel.data().name || hotelUid).slice(0, 200),
      productActions: { catalog, supplier },
      references: {
        suppliers: permissionAllows(permissions, "suppliers", "read"),
        categories: permissionAllows(permissions, "catalogproducts", "read"),
        mappings: permissionAllows(permissions, "suppliers", "read") && permissionAllows(permissions, "supplierproducts", "read"),
      },
    });
  }
  return { hotels, requiresExplicitHotel: true };
}

module.exports = { READ_SCOPE, PROPOSE_SCOPE, requireMcpScope, requireMcpHotelPermission, discoverMcpHotelsHandler };
