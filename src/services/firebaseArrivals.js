import { collection, db, doc, getDoc, getDocs } from "../firebaseConfig";

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeRecords(records) {
  if (Array.isArray(records)) return records;
  if (records && typeof records === "object") return Object.values(records);
  return [];
}

export async function getArrivalDates(hotelUid) {
  if (!hotelUid) return [];

  const snapshot = await getDocs(
    collection(db, "hotels", hotelUid, "reports", "arrivalsdetailed", "arrivalDate")
  );

  return snapshot.docs
    .map((dateDocument) => dateDocument.id)
    .filter((dateKey) => DATE_KEY_PATTERN.test(dateKey))
    .sort((a, b) => b.localeCompare(a));
}

export async function getArrivals(hotelUid, arrivalDate) {
  if (!hotelUid || !DATE_KEY_PATTERN.test(String(arrivalDate || ""))) return [];

  const dateReference = doc(
    db,
    "hotels",
    hotelUid,
    "reports",
    "arrivalsdetailed",
    "arrivalDate",
    arrivalDate
  );
  const dateSnapshot = await getDoc(dateReference);
  const embeddedRecords = dateSnapshot.exists() ? normalizeRecords(dateSnapshot.data()?.records) : [];

  const records = embeddedRecords.length
    ? embeddedRecords
    : (await getDocs(collection(dateReference, "records"))).docs.map((record) => ({
        ...record.data(),
        documentId: record.id,
      }));

  return records.map((record, index) => ({
    ...record,
    id: String(record.id || record.documentId || `${arrivalDate}-${index}`),
  }));
}

