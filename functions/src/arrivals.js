const { getFirestore } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RATE_CODE_REPORT_PATH = "ratecodeheader";
const ARRIVAL_REPORT_PATHS = new Set(["arrivalsdetailed", "arrivalsmadeyesterday"]);

async function getNonEmptyDateKeys(reportReference) {
  const dateCollections = await reportReference.listCollections();
  const dateCollectionsWithContent = await Promise.all(dateCollections
    .filter((dateCollection) => DATE_KEY_PATTERN.test(dateCollection.id))
    .map(async (dateCollection) => ({
      id: dateCollection.id,
      hasRecords: !(await dateCollection.limit(1).get()).empty,
    })));

  return dateCollectionsWithContent
    .filter(({ hasRecords }) => hasRecords)
    .map(({ id }) => id)
    .sort((a, b) => b.localeCompare(a));
}

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

  const requestedReport = String(request.data?.report || "arrivalsdetailed").trim();
  if (!ARRIVAL_REPORT_PATHS.has(requestedReport)) {
    throw new HttpsError("invalid-argument", "Unsupported arrival report.");
  }

  // Arrival dates are collection IDs below this document. Collection IDs cannot
  // be enumerated by the browser Firestore SDK, so this lookup must run as Admin.
  const reportReference = getFirestore().doc(`hotels/${hotelUid}/reports/${requestedReport}`);
  const dates = await getNonEmptyDateKeys(reportReference);

  return { dates };
});

async function getLatestDateCollection(reportReference) {
  const dateCollections = await reportReference.listCollections();
  return dateCollections
    .filter((dateCollection) => DATE_KEY_PATTERN.test(dateCollection.id))
    .sort((a, b) => b.id.localeCompare(a.id))[0];
}

function getDescriptionUpdates(arrivalRecords, descriptions) {
  return arrivalRecords.flatMap((record) => {
    const data = record.data();
    const description = descriptions[String(data?.rateCode || "").trim()] || "";
    return data?.description === description ? [] : [{ record, description }];
  });
}

async function linkLatestArrivalDescriptionsForHotel(hotelUid, db = getFirestore()) {
  const rateCodeReport = db.doc(`hotels/${hotelUid}/reports/${RATE_CODE_REPORT_PATH}`);
  const detailedArrivalsReport = db.doc(`hotels/${hotelUid}/reports/arrivalsdetailed`);
  const madeReservationsReport = db.doc(`hotels/${hotelUid}/reports/arrivalsmadeyesterday`);
  const [latestRateCodes, latestArrivals, latestMadeReservations] = await Promise.all([
    getLatestDateCollection(rateCodeReport),
    getLatestDateCollection(detailedArrivalsReport),
    getLatestDateCollection(madeReservationsReport),
  ]);

  if (!latestArrivals && !latestMadeReservations) {
    return { arrivalDate: null, madeReservationDate: null, updated: 0 };
  }

  const [rateCodesSnapshot, arrivalsSnapshot, madeReservationsSnapshot] = await Promise.all([
    latestRateCodes ? latestRateCodes.get() : Promise.resolve({ docs: [] }),
    latestArrivals ? latestArrivals.get() : Promise.resolve({ docs: [] }),
    latestMadeReservations ? latestMadeReservations.get() : Promise.resolve({ docs: [] }),
  ]);

  const descriptions = {};
  rateCodesSnapshot.docs.forEach((record) => {
    const description = record.data()?.description;
    if (typeof description === "string") descriptions[record.id.trim()] = description;
  });

  const bulkWriter = db.bulkWriter();
  const updates = getDescriptionUpdates(
    [...arrivalsSnapshot.docs, ...madeReservationsSnapshot.docs],
    descriptions
  );
  updates.forEach(({ record, description }) => {
    bulkWriter.update(record.ref, { description });
  });
  await bulkWriter.close();

  return {
    arrivalDate: latestArrivals?.id || null,
    madeReservationDate: latestMadeReservations?.id || null,
    updated: updates.length,
  };
}

async function linkLatestArrivalDescriptions() {
  const db = getFirestore();
  const hotelsSnapshot = await db.collection("hotels").get();
  let updated = 0;

  for (const hotel of hotelsSnapshot.docs) {
    const result = await linkLatestArrivalDescriptionsForHotel(hotel.id, db);
    updated += result.updated;
    logger.info("Arrival descriptions linked", { hotelUid: hotel.id, ...result });
  }

  logger.info("Arrival description linking completed", {
    hotels: hotelsSnapshot.size,
    updated,
  });
}

exports.linkLatestArrivalDescriptions = onSchedule(
  { schedule: "0 2 * * *", timeZone: "Europe/Brussels", timeoutSeconds: 540 },
  linkLatestArrivalDescriptions
);
exports.linkLatestArrivalDescriptionsForHotel = linkLatestArrivalDescriptionsForHotel;
exports.getDescriptionUpdates = getDescriptionUpdates;
exports.getNonEmptyDateKeys = getNonEmptyDateKeys;
