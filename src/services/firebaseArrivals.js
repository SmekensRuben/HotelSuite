import { collection, db, functions, getDocs, httpsCallable } from "../firebaseConfig";

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function getArrivalDates(hotelUid) {
  if (!hotelUid) return [];

  const listArrivalDates = httpsCallable(functions, "listArrivalDates");
  const result = await listArrivalDates({ hotelUid });

  return (Array.isArray(result.data?.dates) ? result.data.dates : [])
    .filter((dateKey) => DATE_KEY_PATTERN.test(dateKey))
    .sort((a, b) => b.localeCompare(a));
}

export async function getMadeReservationDates(hotelUid) {
  if (!hotelUid) return [];

  const listArrivalDates = httpsCallable(functions, "listArrivalDates");
  const result = await listArrivalDates({ hotelUid, report: "arrivalsmadeyesterday" });

  return (Array.isArray(result.data?.dates) ? result.data.dates : [])
    .filter((dateKey) => DATE_KEY_PATTERN.test(dateKey))
    .sort((a, b) => b.localeCompare(a));
}

export async function getArrivals(hotelUid, arrivalDate) {
  if (!hotelUid || !DATE_KEY_PATTERN.test(String(arrivalDate || ""))) return [];

  const recordsSnapshot = await getDocs(collection(
    db,
    "hotels",
    hotelUid,
    "reports",
    "arrivalsdetailed",
    arrivalDate
  ));

  return recordsSnapshot.docs.map((record) => ({
    ...record.data(),
    id: record.id,
    documentId: record.id,
  }));
}

export async function getMadeReservations(hotelUid, reservationMadeDate) {
  if (!hotelUid || !DATE_KEY_PATTERN.test(String(reservationMadeDate || ""))) return [];

  const recordsSnapshot = await getDocs(collection(
    db,
    "hotels",
    hotelUid,
    "reports",
    "arrivalsmadeyesterday",
    reservationMadeDate
  ));

  return recordsSnapshot.docs.map((record) => ({
    ...record.data(),
    id: record.id,
    documentId: record.id,
  }));
}
