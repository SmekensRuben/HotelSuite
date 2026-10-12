const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireCurrentVerifiedUser, text } = require("./validation");
const { requireDocumentId, requireHotelSubscription } = require("./subscriptions");
const { normalizedPermissions } = require("./authorization");
const { DATASET_ID, manifestPath } = require("./demoDataPolicy");

const nameOnly = (data) => [data?.firstName, data?.lastName].filter((value) => typeof value === "string")
  .map((value) => value.trim().slice(0, 80)).filter(Boolean).join(" ") || null;

async function getHotelUserDisplayNamesHandler(request, services = {}) {
  const input = request.data;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["hotelUid", "userIds"].includes(key))
    || !Array.isArray(input.userIds) || input.userIds.length > 100) {
    throw new HttpsError("invalid-argument", "Request at most 100 hotel audit display names.");
  }
  const hotelUid = requireDocumentId(input.hotelUid, "hotelUid");
  const userIds = [...new Set(input.userIds.map((id) => text(id, "User identifier", 254, true)))];
  const ids = userIds.filter((id) => id.length <= 128 && !id.includes("/") && ![".", ".."].includes(id));
  const db = services.firestore || admin.firestore();
  return db.runTransaction(async (tx) => {
    await requireCurrentVerifiedUser({ ...request }, services.auth);
    await requireHotelSubscription(db, hotelUid, tx);
    const caller = await tx.get(db.doc(`hotels/${hotelUid}/members/${request.auth.uid}`));
    if (!caller.exists || !normalizedPermissions(caller.data()?.permissions).length) {
      throw new HttpsError("permission-denied", "Hotel membership and operational access are required.");
    }
    const memberships = ids.length ? await tx.getAll(...ids.map((id) => db.doc(`hotels/${hotelUid}/members/${id}`))) : [];
    const members = new Map(ids.map((id, index) => [id, memberships[index]]));
    // The immutable receipt proves who actually seeded this hotel's demo data.
    // Its operator need not have operational membership. No arbitrary global
    // profile can be enumerated through this narrowly scoped author exception.
    let seedActor = null;
    if (ids.some((id) => !members.get(id).exists)) {
      const receipt = await tx.get(db.doc(manifestPath(hotelUid))), data = receipt.data();
      if (receipt.exists && data.datasetId === DATASET_ID && data.status === "complete" && ids.includes(data.actorUid)) seedActor = data.actorUid;
    }
    const profileIds = ids.filter((id) => {
      const member = members.get(id);
      return id === seedActor || member.exists && !Object.hasOwn(member.data(), "firstName") && !Object.hasOwn(member.data(), "lastName");
    });
    const snapshots = profileIds.length ? await tx.getAll(...profileIds.map((id) => db.doc(`users/${id}`))) : [];
    const profiles = new Map(profileIds.map((id, index) => [id, snapshots[index].data()]));
    return { hotelUid, users: userIds.map((userId) => {
      const member = members.get(userId), profile = profiles.get(userId);
      const local = member?.exists ? member.data() : null;
      const hasLocalName = local && (Object.hasOwn(local, "firstName") || Object.hasOwn(local, "lastName"));
      const assignedProfile = profile && (userId === seedActor || Array.isArray(profile.hotelUid) && profile.hotelUid.includes(hotelUid));
      return { userId, displayName: nameOnly(hasLocalName ? local : assignedProfile ? profile : null) };
    }) };
  }, { readOnly: true });
}

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

module.exports = { getHotelUserDisplayNameHandler, getHotelUserDisplayNamesHandler,
  getHotelUserDisplayNames: onCall({ region: "us-central1", cors: true, timeoutSeconds: 60 }, getHotelUserDisplayNamesHandler),
  getHotelUserDisplayName: onCall({ region: "us-central1", cors: true }, getHotelUserDisplayNameHandler) };
