const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requirePlatformAdministrator, requireHotelSubscription } = require("./subscriptions");
const { requireSaasRollout } = require("./saasRollout");
const { permissionAllows, normalizedPermissions } = require("./authorization");
const { writePlatformAudit } = require("./platformAudit");
const { localDate } = require("./importMonitoringPolicy");
const { validTimeZone } = require("./hotelSetupPolicy");
const inventory = require("./inventoryPolicy");
const { buildDemoData } = require("./demoDataFixtures");
const { TEST_HOTEL_UID, DATASET_ID, SUPPLIER_IDS, manifestPath } = require("./demoDataPolicy");

async function manageHotelDemoDataHandler(request, services = {}) {
  const input = request.data;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["hotelUid", "action", "datasetId"].includes(key))
    || input.hotelUid !== TEST_HOTEL_UID || input.datasetId !== DATASET_ID || !["preview", "apply"].includes(input.action)) {
    throw new HttpsError("invalid-argument", "This demo dataset is available only for test-hotel-2 and its reviewed dataset version.");
  }
  const db = services.firestore || admin.firestore(), auth = services.auth || admin.auth();
  return db.runTransaction(async (tx) => {
    // Revalidate current platform authority on every real SDK transaction retry.
    await requirePlatformAdministrator({ ...request }, auth);
    await requireSaasRollout(db, tx);
    await requireHotelSubscription(db, TEST_HOTEL_UID, tx, "procurement");
    const hotel = await tx.get(db.doc(`hotels/${TEST_HOTEL_UID}`));
    if (!hotel.exists) throw new HttpsError("not-found", "Create the test hotel before loading demo data.");
    const ref = db.doc(manifestPath(TEST_HOTEL_UID)), prior = await tx.get(ref);
    if (prior.exists) {
      const data = prior.data();
      if (data.datasetId !== DATASET_ID || data.status !== "complete" || !data.summary) throw new HttpsError("failed-precondition", "The demo receipt needs operator review. No records were changed.");
      return { hotelUid: TEST_HOTEL_UID, datasetId: DATASET_ID, status: "complete", businessDate: data.businessDate, timeZone: data.timeZone,
        summary: data.summary, alreadyLoaded: true, canApply: false, conflicts: [] };
    }
    const bootstrap = await tx.get(db.doc(`hotels/${TEST_HOTEL_UID}/settings/bootstrap`));
    const currency = inventory.currency(bootstrap.data()?.currency);
    if (hotel.data().currency != null && hotel.data().currency !== currency) throw new HttpsError("failed-precondition", "Hotel currency settings disagree. Reconcile them before loading demo data.");
    // Match the count workflow: use the configured hotel zone, otherwise an
    // explicit UTC demo date. No hotel settings are inferred or rewritten.
    const timeZone = validTimeZone(hotel.data().timeZone) ? hotel.data().timeZone : "UTC";
    const businessDate = localDate(services.now?.() ?? Date.now(), timeZone);
    const administrators = await tx.get(db.collection(`hotels/${TEST_HOTEL_UID}/members`).where("hotelAdmin", "==", true).limit(21));
    if (administrators.size > 20) throw new HttpsError("failed-precondition", "Review more than twenty test-hotel administrators before seeding demo approvers.");
    const approvers = [];
    for (const member of administrators.docs) {
      if (!permissionAllows(normalizedPermissions(member.data().permissions), "orders", "approve")) continue;
      let user;
      try { user = await auth.getUser(member.id); }
      catch { throw new HttpsError("failed-precondition", "A test-hotel administrator has no current Auth account. Reconcile the membership first."); }
      if (user.disabled || !user.emailVerified || !user.email) continue;
      approvers.push({ uid: member.id, email: user.email, name: user.displayName || user.email });
    }
    const fixture = buildDemoData({ actorUid: request.auth.uid, businessDate, currency, approvers });
    if (fixture.docs.length > 350 || new Set(fixture.docs.map((d) => d.path)).size !== fixture.docs.length) throw new Error("Demo dataset exceeds its reviewed transaction bound or contains duplicate paths.");
    const existing = await tx.getAll(...fixture.docs.map(({ path }) => db.doc(path)));
    const conflicts = existing.filter((doc) => doc.exists).map((doc) => doc.ref.path);
    const result = { hotelUid: TEST_HOTEL_UID, datasetId: DATASET_ID, status: "preview", businessDate, timeZone,
      summary: fixture.summary, alreadyLoaded: false, canApply: conflicts.length === 0, conflicts: conflicts.slice(0, 20), conflictCount: conflicts.length };
    if (input.action === "preview") return result;
    if (conflicts.length) throw new HttpsError("already-exists", "Demo IDs already exist without their seed receipt. Review the preview conflicts; existing records are never overwritten.");
    // One transaction: the complete fixture and immutable seed receipt succeed
    // together. There is no reset, delete, incremental migration or notification.
    for (const { path, data } of fixture.docs) tx.create(db.doc(path), data);
    tx.create(ref, { datasetId: DATASET_ID, status: "complete", businessDate, timeZone, currency, actorUid: request.auth.uid,
      supplierIds: SUPPLIER_IDS, summary: fixture.summary, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    writePlatformAudit(tx, db, { key: DATASET_ID, hotelUid: TEST_HOTEL_UID, actorUid: request.auth.uid, action: "demo-data-loaded", targetId: DATASET_ID });
    return { ...result, status: "complete", canApply: false };
  });
}
module.exports = { manageHotelDemoDataHandler,
  manageHotelDemoData: onCall({ region: "us-central1", cors: true, timeoutSeconds: 120, maxInstances: 2, concurrency: 4 }, manageHotelDemoDataHandler) };
