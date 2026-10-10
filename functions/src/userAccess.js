const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { text } = require("./validation");
const catalog = require("./permissionCatalog.json");
const { requireDocumentId, requirePlatformAdministrator } = require("./subscriptions");
const { readTeamGuard, writeTeamGuard } = require("./hotelTeam");
const { ADMIN_PERMISSIONS } = require("./modulePolicy");
const { gated } = require("./saasRollout");
const { writePlatformAudit } = require("./platformAudit");

function normalizeStrings(values) {
  return Array.isArray(values)
    ? [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
    : [];
}

function normalizeMemberships(hotelUids, memberships) {
  return Object.fromEntries(hotelUids.map((hotelUid) => [
    hotelUid,
    normalizeStrings(normalizeStrings(memberships?.[hotelUid]).map((key) => key.toLowerCase())),
  ]));
}

async function updateUserAccessHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);

  const userId = requireDocumentId(request.data?.userId, "userId");
  const profile = request.data?.profile && typeof request.data.profile === "object" ? request.data.profile : {};
  const firstName = text(profile.firstName || "", "First name", 80);
  const lastName = text(profile.lastName || "", "Last name", 80);
  const hotelUids = normalizeStrings(profile.hotelUid);
  if (hotelUids.length > 50) throw new HttpsError("invalid-argument", "At most 50 hotels may be assigned in one save.");
  hotelUids.forEach((hotelUid) => requireDocumentId(hotelUid, "hotelUid"));
  const expectedRevision = request.data?.expectedAccessRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new HttpsError("invalid-argument", "expectedAccessRevision is required.");
  const memberships = normalizeMemberships(hotelUids, request.data?.memberships || {});
  const validPermissions = new Set(Object.entries(catalog).flatMap(([feature, actions]) => [...actions, "*"].map((action) => `${feature}.${action}`.toLowerCase())));
  for (const permissions of Object.values(memberships)) {
    if (permissions.length > 200 || permissions.some((key) => !validPermissions.has(key))) {
      throw new HttpsError("invalid-argument", "Invalid membership permissions.");
    }
  }
  const firestore = services.firestore || admin.firestore();
  const auth = services.auth || admin.auth();
  // Verify the Auth identity before writing any profile or membership data.
  const targetUser = await auth.getUser(userId);
  const userRef = firestore.doc(`users/${userId}`);
  const auditRef = firestore.collection("userAccessAudit").doc();
  return firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(userRef);
    if (!current.exists) throw new HttpsError("not-found", "User profile not found.");
    const previous = current.data();
    if ((previous.accessRevision || 0) !== expectedRevision) {
      throw new HttpsError("aborted", "User access changed. Reload before saving.");
    }
    if (previous.hotelUid !== undefined && !Array.isArray(previous.hotelUid)) throw new HttpsError("failed-precondition", "Review the user's stored hotel assignments before changing access.");
    const previousHotelUids = normalizeStrings(previous.hotelUid);
    previousHotelUids.forEach((hotelUid) => requireDocumentId(hotelUid, "stored hotelUid"));
    const hotelSnapshots = await Promise.all(hotelUids.map((hotelUid) => transaction.get(firestore.doc(`hotels/${hotelUid}`))));
    if (hotelSnapshots.some((snapshot) => !snapshot.exists)) throw new HttpsError("not-found", "An assigned hotel does not exist.");
    const affectedHotels = [...new Set([...previousHotelUids, ...hotelUids])].sort();
    const previousMembers = await Promise.all(affectedHotels.map((hotelUid) =>
      transaction.get(firestore.doc(`hotels/${hotelUid}/members/${userId}`))));
    const subscriptions = await Promise.all(affectedHotels.map((hotelUid) => transaction.get(firestore.doc(`hotelSubscriptions/${hotelUid}`))));
    const guards = await Promise.all(affectedHotels.map((hotelUid, index) => readTeamGuard(firestore, transaction, hotelUid, {
      removingAdminUid: previousMembers[index].data()?.hotelAdmin === true && !hotelUids.includes(hotelUid) ? userId : null,
      addingMember: !previousMembers[index].exists && hotelUids.includes(hotelUid),
      seatLimit: subscriptions[index].data()?.seatLimit ?? null,
    })));
    affectedHotels.forEach((hotelUid, index) => {
      if (hotelUids.includes(hotelUid) && previousMembers[index].data()?.hotelAdmin === true) {
        memberships[hotelUid] = [...new Set([...memberships[hotelUid], ...ADMIN_PERMISSIONS])].sort();
      }
    });
    const permissionDeltas = affectedHotels.map((hotelUid, index) => {
      const before = normalizeStrings(normalizeStrings(previousMembers[index].data()?.permissions).map((key) => key.toLowerCase())).sort();
      const after = (memberships[hotelUid] || []).slice().sort();
      return { hotelUid, before, after, added: after.filter((key) => !before.includes(key)),
        removed: before.filter((key) => !after.includes(key)) };
    });
    transaction.update(userRef, {
      firstName,
      lastName,
      email: targetUser.email || "",
      hotelUid: hotelUids,
      permissions: admin.firestore.FieldValue.delete(),
      accessRevision: expectedRevision + 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: request.auth.uid,
    });
    hotelUids.forEach((hotelUid) => transaction.set(firestore.doc(`hotels/${hotelUid}/members/${userId}`), {
      permissions: memberships[hotelUid],
      moduleRoles: {}, additionalPermissions: memberships[hotelUid].filter((key) => !key.startsWith("users.")), rolePolicyVersion: 1,
      firstName, lastName,
      revision: (previousMembers[affectedHotels.indexOf(hotelUid)].data()?.revision || 0) + 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }));
    guards.forEach((guard) => writeTeamGuard(transaction, guard, request.auth.uid));
    previousHotelUids.filter((hotelUid) => !hotelUids.includes(hotelUid))
      .forEach((hotelUid) => transaction.delete(firestore.doc(`hotels/${hotelUid}/members/${userId}`)));
    transaction.set(auditRef, {
      userId, actorUid: request.auth.uid, hotelUids,
      removedHotelUids: previousHotelUids.filter((hotelUid) => !hotelUids.includes(hotelUid)),
      permissionDeltas,
      revision: expectedRevision + 1,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    (affectedHotels.length ? affectedHotels : [null]).forEach((hotelUid) => writePlatformAudit(transaction, firestore, { key: auditRef.id, hotelUid,
      actorUid: request.auth.uid, action: "user-access-updated", targetId: userId, revision: expectedRevision + 1 }));
    return { hotelUids, permissionsUpdated: true, accessRevision: expectedRevision + 1 };
  });
}

// Callable functions normally enable CORS by default. Keep it explicit because
// this endpoint is invoked from Vercel preview origins as well as production.
const updateUserAccess = onCall({ region: "us-central1", cors: true }, gated(updateUserAccessHandler));

module.exports = { normalizeStrings, normalizeMemberships, updateUserAccessHandler, updateUserAccess };
