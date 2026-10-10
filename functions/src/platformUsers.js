const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requirePlatformAdministrator, requireDocumentId } = require("./subscriptions");

function profileView(snapshot, identity) {
  const data = snapshot.data();
  if (data.hotelUid !== undefined && !Array.isArray(data.hotelUid)) throw new HttpsError("failed-precondition", "A user profile needs assignment review.");
  const assignments = Array.isArray(data.hotelUid) ? data.hotelUid : [];
  if (assignments.length > 50 || assignments.some((id) => typeof id !== "string" || !id || id.length > 128 || id.includes("/"))) throw new HttpsError("failed-precondition", "A user profile needs assignment review.");
  const revision = data.accessRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new HttpsError("failed-precondition", "A user profile needs revision review.");
  return { id: snapshot.id, firstName: String(data.firstName || "").slice(0, 80), lastName: String(data.lastName || "").slice(0, 80),
    email: identity?.email ?? null, disabled: identity?.disabled ?? null, hotelUid: [...new Set(assignments)], accessRevision: revision };
}
async function listPlatformUsersHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const db = services.firestore || admin.firestore(), auth = services.auth || admin.auth();
  let query = db.collection("users").orderBy(admin.firestore.FieldPath.documentId());
  if (request.data?.afterUid) query = query.startAfter(requireDocumentId(request.data.afterUid, "cursor"));
  const result = await query.limit(51).get();
  const page = result.docs.slice(0, 50);
  const identities = page.length ? await auth.getUsers(page.map((row) => ({ uid: row.id }))) : { users: [] };
  const map = new Map(identities.users.map((user) => [user.uid, user]));
  return { users: page.map((row) => profileView(row, map.get(row.id))), nextCursor: result.size > 50 ? page.at(-1).id : null };
}
async function getPlatformUserAccessHandler(request, services = {}) {
  await requirePlatformAdministrator(request, services.auth);
  const db = services.firestore || admin.firestore(), auth = services.auth || admin.auth();
  const userId = requireDocumentId(request.data?.userId, "userId");
  const profile = await db.doc(`users/${userId}`).get();
  if (!profile.exists) return { user: null, memberships: {} };
  let identity;
  try { identity = await auth.getUser(userId); }
  catch { throw new HttpsError("failed-precondition", "The user's Auth identity is unavailable. Review it before editing access."); }
  const user = profileView(profile, identity);
  const members = user.hotelUid.length ? await db.getAll(...user.hotelUid.map((hotelUid) => db.doc(`hotels/${hotelUid}/members/${userId}`))) : [];
  const memberships = Object.fromEntries(members.map((member, index) => [user.hotelUid[index], member.exists && Array.isArray(member.data().permissions) ? member.data().permissions.filter((key) => typeof key === "string").slice(0, 200) : []]));
  return { user, memberships };
}
module.exports = { listPlatformUsersHandler, getPlatformUserAccessHandler,
  listPlatformUsers: onCall({ region: "us-central1", cors: true }, listPlatformUsersHandler),
  getPlatformUserAccess: onCall({ region: "us-central1", cors: true }, getPlatformUserAccessHandler) };
