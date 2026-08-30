const { getFirestore } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RATE_CODE_REPORT_PATH = "ratecodeheader";

async function userCanAccessHotel(userUid, hotelUid) {
  const userSnapshot = await getFirestore().doc(`users/${userUid}`).get();
  const hotelUids = userSnapshot.exists && Array.isArray(userSnapshot.data()?.hotelUid)
    ? userSnapshot.data().hotelUid
    : [];
  return hotelUids.includes(hotelUid);
}

exports.listArrivalDates = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }

  const hotelUid = String(request.data?.hotelUid || "").trim();
  if (!hotelUid) {
    throw new HttpsError("invalid-argument", "hotelUid is required.");
  }
  if (!(await userCanAccessHotel(request.auth.uid, hotelUid))) {
    throw new HttpsError("permission-denied", "You do not have access to this hotel.");
  }

  // Arrival dates are collection IDs below this document. Collection IDs cannot
  // be enumerated by the browser Firestore SDK, so this lookup must run as Admin.
  const reportReference = getFirestore().doc(`hotels/${hotelUid}/reports/arrivalsdetailed`);
  const dateCollections = await reportReference.listCollections();
  const dates = dateCollections
    .map((dateCollection) => dateCollection.id)
    .filter((dateKey) => DATE_KEY_PATTERN.test(dateKey))
    .sort((a, b) => b.localeCompare(a));

  return { dates };
});

exports.getLatestRateCodeDescriptions = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }

  const hotelUid = String(request.data?.hotelUid || "").trim();
  if (!hotelUid) {
    throw new HttpsError("invalid-argument", "hotelUid is required.");
  }
  if (!(await userCanAccessHotel(request.auth.uid, hotelUid))) {
    throw new HttpsError("permission-denied", "You do not have access to this hotel.");
  }

  const reportReference = getFirestore().doc(
    `hotels/${hotelUid}/reports/${RATE_CODE_REPORT_PATH}`
  );
  const dateCollections = await reportReference.listCollections();
  const latestDateCollection = dateCollections
    .filter((dateCollection) => DATE_KEY_PATTERN.test(dateCollection.id))
    .sort((a, b) => b.id.localeCompare(a.id))[0];

  if (!latestDateCollection) return { reportDate: null, descriptions: {} };

  const recordsSnapshot = await latestDateCollection.get();
  const descriptions = {};
  recordsSnapshot.docs.forEach((record) => {
    const description = record.data()?.description;
    if (typeof description === "string") descriptions[record.id] = description;
  });

  return { reportDate: latestDateCollection.id, descriptions };
});
