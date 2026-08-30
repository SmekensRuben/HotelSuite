const { getFirestore } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

