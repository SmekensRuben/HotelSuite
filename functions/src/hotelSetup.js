const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requirePlatformAdministrator, requireDocumentId } = require("./subscriptions");
const { SAAS_RULES_VERSION } = require("./saasRollout");
const { buildHotelSetupReport } = require("./hotelSetupPolicy");

const rows = (snapshot, limit) => snapshot.docs.slice(0, limit).map((doc) => ({ id: doc.id, data: doc.data() }));
async function getHotelSetupReadinessHandler(request, services = {}) {
  const auth = services.auth || admin.auth();
  await requirePlatformAdministrator(request, auth);
  const hotelUid = requireDocumentId(request.data?.hotelUid, "hotelUid");
  const db = services.firestore || admin.firestore();
  const raw = await db.runTransaction(async (tx) => {
    const [hotel, subscription, bootstrap, release] = await tx.getAll(db.doc(`hotels/${hotelUid}`),
      db.doc(`hotelSubscriptions/${hotelUid}`), db.doc(`hotels/${hotelUid}/settings/bootstrap`),
      db.doc("platformConfiguration/saasProcurement"));
    if (!hotel.exists) throw new HttpsError("not-found", "Hotel not found.");
    const names = ["members", "outlets", "suppliers", "supplierproducts", "locations", "fileImportTypes", "importMonitors"];
    const limits = [500, 25, 100, 100, 100, 100, 100];
    const snapshots = await Promise.all(names.map((name, index) => tx.get(db.collection(`hotels/${hotelUid}/${name}`).limit(limits[index] + 1))));
    const assigned = await tx.get(db.collection("users").where("hotelUid", "array-contains", hotelUid).limit(501));
    const members = rows(snapshots[0], 500), profiles = rows(assigned, 500);
    const stockTemplates = await Promise.all(rows(snapshots[4], 100).map((location) => tx.get(db.collection(`hotels/${hotelUid}/locations/${location.id}/stockTemplates`).select().limit(1))));
    const found = new Set(profiles.map((profile) => profile.id));
    const missing = members.filter((member) => !found.has(member.id));
    const extras = missing.length ? await tx.getAll(...missing.map((member) => db.doc(`users/${member.id}`))) : [];
    extras.filter((doc) => doc.exists).forEach((doc) => profiles.push({ id: doc.id, data: doc.data() }));
    const approvers = await Promise.all(rows(snapshots[1], 25).map((outlet) => tx.get(db.collection(`hotels/${hotelUid}/outlets/${outlet.id}/approvers`).limit(21))));
    const invitations = await tx.get(db.collection(`hotels/${hotelUid}/invitations`).orderBy("createdAt", "desc").limit(10));
    const latest = invitations.docs;
    const mail = latest.length ? await tx.getAll(...latest.map((invite) => db.doc(`hotels/${hotelUid}/mailQueue/invite-${invite.id}`))) : [];
    const statuses = ["queued", "processing", "sent", "failed", "blocked", "needs-review"];
    return { hotelUid, hotel: hotel.data(), subscription: subscription.data(), bootstrap: bootstrap.data(),
      releaseReady: release.data()?.enabled === true && release.data().rulesVersion === SAAS_RULES_VERSION,
      members, profiles, outlets: rows(snapshots[1], 25), suppliers: rows(snapshots[2], 100),
      products: rows(snapshots[3], 100), locations: rows(snapshots[4], 100), importTypes: rows(snapshots[5], 100), monitors: rows(snapshots[6], 100),
      stockTemplateLocations: stockTemplates.filter((page) => !page.empty).length,
      approverUids: [...new Set(approvers.flatMap((page) => page.docs.slice(0, 20).map((doc) => doc.id)))],
      truncated: assigned.size > 500 || snapshots[0].size > 500,
      sourceSampleTruncated: [1, 2, 3, 4].some((index) => snapshots[index].size > limits[index]),
      approversTruncated: snapshots[1].size > 25 || approvers.some((page) => page.size > 20),
      importsTruncated: snapshots[5].size > 100 || snapshots[6].size > 100,
      invitations: latest.map((invite, index) => ({ id: invite.id, uid: String(invite.data().uid || "").slice(0, 128),
        status: statuses.includes(mail[index].data()?.status) ? mail[index].data().status : "unknown",
        createdAtMillis: invite.data().createdAt?.toMillis?.() ?? null })) };
  }, { readOnly: true });
  const ids = [...new Set([...raw.members, ...raw.profiles].map((row) => row.id))];
  raw.invalidUserIds = ids.filter((uid) => !uid || uid.length > 128);
  const valid = ids.filter((uid) => !raw.invalidUserIds.includes(uid));
  raw.identities = [];
  // Auth errors propagate. Permission/provider failures are never account-not-found.
  for (let index = 0; index < valid.length; index += 100) {
    const batch = valid.slice(index, index + 100);
    const result = await auth.getUsers(batch.map((uid) => ({ uid })));
    if (!Array.isArray(result.users) || !Array.isArray(result.notFound)
      || batch.some((uid) => !result.users.some((user) => user.uid === uid) && !result.notFound.some((missing) => missing.uid === uid))) {
      throw new HttpsError("unavailable", "Current account evidence is incomplete. Retry the readiness check.");
    }
    raw.identities.push(...result.users.map((user) => ({ uid: user.uid, disabled: user.disabled, emailVerified: user.emailVerified,
      platformAdmin: user.customClaims?.platformAdmin === true })));
  }
  await requirePlatformAdministrator({ ...request }, auth);
  return buildHotelSetupReport(raw, services.now?.() ?? Date.now());
}
module.exports = { getHotelSetupReadinessHandler,
  getHotelSetupReadiness: onCall({ region: "us-central1", cors: true, timeoutSeconds: 120 }, getHotelSetupReadinessHandler) };
