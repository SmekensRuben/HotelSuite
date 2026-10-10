const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireCurrentVerifiedUser, text, revision, digest } = require("./validation");
const { requireDocumentId, requireHotelSubscription } = require("./subscriptions");
const { compileMemberAccess, validateSeatLimit } = require("./modulePolicy");
const { gated, enforceRequestRollout } = require("./saasRollout");

const stamp = () => admin.firestore.FieldValue.serverTimestamp();

async function requireHotelAdministrator(db, request, hotelUid, tx, auth) {
  await requireCurrentVerifiedUser(request, auth);
  await enforceRequestRollout(db, request, tx);
  const memberRef = db.doc(`hotels/${hotelUid}/members/${request.auth.uid}`);
  if (request.auth.token?.platformAdmin !== true) {
    const member = tx ? await tx.get(memberRef) : await memberRef.get();
    if (!member.exists || member.data().hotelAdmin !== true) {
      throw new HttpsError("permission-denied", "Hotel administrator access is required for this hotel.");
    }
  }
  return requireHotelSubscription(db, hotelUid, tx);
}

// All membership-changing commands read and update this shared lock. It serializes
// last-admin and seat checks, including concurrent changes to different members.
async function readTeamGuard(db, tx, hotelUid, { removingAdminUid, addingMember = false, addingAdmin = false, seatLimit = null } = {}) {
  validateSeatLimit(seatLimit);
  const ref = db.doc(`hotels/${hotelUid}/memberAdministration/state`);
  const state = await tx.get(ref);
  const admins = await tx.get(db.collection(`hotels/${hotelUid}/members`).where("hotelAdmin", "==", true).limit(21));
  if (addingAdmin && admins.size >= 20) throw new HttpsError("resource-exhausted", "At most twenty hotel administrators are supported.");
  if (removingAdminUid && !admins.docs.some((member) => member.id !== removingAdminUid)) {
    throw new HttpsError("failed-precondition", "Appoint another hotel administrator before removing the last one.");
  }
  if (addingMember && seatLimit !== null) {
    const members = await tx.get(db.collection(`hotels/${hotelUid}/members`).limit(seatLimit + 1));
    if (members.size >= seatLimit) throw new HttpsError("resource-exhausted", "This hotel's assigned-user limit has been reached. Existing users keep their access.");
  }
  return { ref, next: { revision: revision(state.data()?.revision || 0) + 1, updatedAt: stamp() } };
}
function writeTeamGuard(tx, guard, actorUid) {
  tx.set(guard.ref, { ...guard.next, updatedBy: actorUid });
}
function memberView(member, profile) {
  const data = member.data();
  const fallback = profile?.data() || {};
  return { id: member.id, firstName: String(data.firstName ?? fallback.firstName ?? "").slice(0, 80), lastName: String(data.lastName ?? fallback.lastName ?? "").slice(0, 80),
    email: String(data.email || fallback.email || "").slice(0, 254), hotelAdmin: data.hotelAdmin === true,
    revision: data.revision || 0, moduleRoles: data.moduleRoles || {},
    additionalPermissions: Array.isArray(data.additionalPermissions) ? data.additionalPermissions : null,
    permissions: Array.isArray(data.permissions) ? data.permissions : [], rolePolicyVersion: data.rolePolicyVersion || null };
}
async function listHotelTeamHandler(request, services = {}) {
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  const db = services.firestore || admin.firestore();
  const subscription = await requireHotelAdministrator(db, request, hotelUid, undefined, services.auth);
  let members;
  if (request.data?.userId) {
    const userId = requireDocumentId(request.data.userId, "userId");
    const member = await db.doc(`hotels/${hotelUid}/members/${userId}`).get();
    if (!member.exists) throw new HttpsError("not-found", "Hotel member not found.");
    members = { docs: [member], size: 1 };
  } else {
    let query = db.collection(`hotels/${hotelUid}/members`).orderBy(admin.firestore.FieldPath.documentId());
    if (request.data?.afterUid) query = query.startAfter(requireDocumentId(request.data.afterUid, "afterUid"));
    members = await query.limit(51).get();
  }
  const page = members.docs.slice(0, 50);
  // Legacy memberships may lack names/email. Hydrate only this hotel's bounded
  // member IDs and return the same narrow projection, never global assignments.
  const profiles = page.length ? await db.getAll(...page.map((member) => db.doc(`users/${member.id}`))) : [];
  return { users: page.map((member, index) => memberView(member, profiles[index])), nextCursor: members.size > 50 ? page.at(-1).id : null,
    modules: subscription.modules, seatLimit: subscription.seatLimit ?? null };
}
async function updateHotelMemberHandler(request, services = {}) {
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const userId = requireDocumentId(input.userId, "userId");
  const expected = revision(input.expectedRevision);
  const firstName = text(input.firstName || "", "First name", 80);
  const lastName = text(input.lastName || "", "Last name", 80);
  const db = services.firestore || admin.firestore();
  const memberRef = db.doc(`hotels/${hotelUid}/members/${userId}`);
  return db.runTransaction(async (tx) => {
    const subscription = await requireHotelAdministrator(db, request, hotelUid, tx, services.auth);
    const [member, profile] = await Promise.all([tx.get(memberRef), tx.get(db.doc(`users/${userId}`))]);
    if (!member.exists || !profile.exists) throw new HttpsError("not-found", "Hotel member not found.");
    if ((member.data().revision || 0) !== expected) throw new HttpsError("aborted", "This hotel member changed. Reload before saving.");
    const access = compileMemberAccess(input, subscription, member.data().permissions || [], member.data().moduleRoles || {});
    const guard = await readTeamGuard(db, tx, hotelUid, {
      removingAdminUid: member.data().hotelAdmin === true && !access.hotelAdmin ? userId : null,
      addingAdmin: member.data().hotelAdmin !== true && access.hotelAdmin,
    });
    const auditRef = db.collection(`hotels/${hotelUid}/accessAudit`).doc();
    tx.set(memberRef, { ...access, firstName, lastName, revision: expected + 1, updatedAt: stamp(), updatedBy: request.auth.uid }, { merge: true });
    // Changing this hotel's display names does not rewrite another hotel's profile.
    tx.update(profile.ref, { accessRevision: (profile.data().accessRevision || 0) + 1 });
    writeTeamGuard(tx, guard, request.auth.uid);
    tx.create(auditRef, { action: "update-member", uid: userId, actorUid: request.auth.uid,
      previousPermissions: member.data().permissions || [], permissions: access.permissions,
      previousHotelAdmin: member.data().hotelAdmin === true, hotelAdmin: access.hotelAdmin,
      moduleRoles: access.moduleRoles, revision: expected + 1, createdAt: stamp() });
    return { revision: expected + 1 };
  });
}
async function removeHotelMemberHandler(request, services = {}) {
  const input = request.data || {};
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const userId = requireDocumentId(input.userId, "userId");
  const expected = revision(input.expectedRevision);
  const requestId = requireDocumentId(input.requestId, "requestId");
  const db = services.firestore || admin.firestore();
  const receipt = db.doc(`hotels/${hotelUid}/accessAudit/remove-${digest(request.auth?.uid, requestId)}`);
  const fingerprint = digest(userId, expected);
  return db.runTransaction(async (tx) => {
    await requireHotelAdministrator(db, request, hotelUid, tx, services.auth);
    const memberRef = db.doc(`hotels/${hotelUid}/members/${userId}`);
    const [member, profile, previous] = await Promise.all([tx.get(memberRef), tx.get(db.doc(`users/${userId}`)), tx.get(receipt)]);
    if (previous.exists) {
      if (previous.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This removal request identifies another change.");
      return { removed: true };
    }
    if (!member.exists || !profile.exists) throw new HttpsError("not-found", "Hotel member not found.");
    if ((member.data().revision || 0) !== expected) throw new HttpsError("aborted", "This hotel member changed. Reload before removing access.");
    const guard = await readTeamGuard(db, tx, hotelUid, { removingAdminUid: member.data().hotelAdmin === true ? userId : null });
    const hotelUids = profile.data().hotelUid;
    if (!Array.isArray(hotelUids)) throw new HttpsError("failed-precondition", "Review this member's hotel assignments.");
    tx.delete(memberRef);
    tx.update(profile.ref, { hotelUid: hotelUids.filter((id) => id !== hotelUid), accessRevision: (profile.data().accessRevision || 0) + 1 });
    writeTeamGuard(tx, guard, request.auth.uid);
    tx.create(receipt, { action: "remove-member", uid: userId, actorUid: request.auth.uid,
      previousPermissions: member.data().permissions || [], previousHotelAdmin: member.data().hotelAdmin === true, fingerprint, createdAt: stamp() });
    return { removed: true };
  });
}
const options = { region: "us-central1", cors: true };
module.exports = { requireHotelAdministrator, readTeamGuard, writeTeamGuard, listHotelTeamHandler,
  updateHotelMemberHandler, removeHotelMemberHandler,
  listHotelTeam: onCall(options, gated(listHotelTeamHandler)), updateHotelMember: onCall(options, gated(updateHotelMemberHandler)),
  removeHotelMember: onCall(options, gated(removeHotelMemberHandler)) };
