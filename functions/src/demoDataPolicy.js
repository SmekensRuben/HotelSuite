const { HttpsError } = require("firebase-functions/v2/https");

const TEST_HOTEL_UID = "test-hotel-2";
const DATASET_ID = "procurement-demo-v1";
const PREFIX = "demo-v1-";
const SUPPLIER_IDS = ["fresh", "pantry", "drinks"].map((id) => `${PREFIX}supplier-${id}`);
const manifestPath = (hotelUid) => `hotels/${hotelUid}/demoDataSeeds/${DATASET_ID}`;

// The private seed receipt owns this mode. Editing public supplier contact
// details can never turn a reserved demo supplier into an external delivery.
async function demoSupplierMode(db, hotelUid, supplierId, tx) {
  if (hotelUid !== TEST_HOTEL_UID || !SUPPLIER_IDS.includes(supplierId)) return false;
  const ref = db.doc(manifestPath(hotelUid));
  const receipt = tx ? await tx.get(ref) : await ref.get();
  if (!receipt.exists || receipt.data().datasetId !== DATASET_ID || receipt.data().status !== "complete") {
    throw new HttpsError("failed-precondition", "The reserved demo supplier needs its verified demo dataset. No external delivery is permitted.");
  }
  return true;
}
module.exports = { TEST_HOTEL_UID, DATASET_ID, PREFIX, SUPPLIER_IDS, manifestPath, demoSupplierMode };
