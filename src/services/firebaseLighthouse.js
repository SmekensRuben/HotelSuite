import { db, doc, serverTimestamp, setDoc, writeBatch } from "../firebaseConfig";

const snapshotPath = (hotelUid, snapshotDate) =>
  `hotels/${hotelUid}/reports/lightHouseData/snapshotDates/${snapshotDate}`;

export async function saveLighthouseData(hotelUid, snapshotDate, rows) {
  if (!hotelUid) throw new Error("Hotel ontbreekt.");
  if (!snapshotDate || !rows?.length) throw new Error("Er is geen Lighthouse-data om op te slaan.");

  const path = snapshotPath(hotelUid, snapshotDate);
  await setDoc(doc(db, path), {
    snapshotDate,
    importedAt: serverTimestamp(),
    stayDateCount: rows.length,
  }, { merge: true });

  for (let start = 0; start < rows.length; start += 500) {
    const batch = writeBatch(db);
    rows.slice(start, start + 500).forEach(({ stayDate, data }) => {
      batch.set(doc(db, `${path}/stayDates/${stayDate}`), data, { merge: true });
    });
    await batch.commit();
  }
}
