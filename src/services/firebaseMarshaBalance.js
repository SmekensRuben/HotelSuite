import { collection, db, doc, documentId, getDoc, getDocs, limit, orderBy, query, setDoc } from "../firebaseConfig";
import { createEmptyMarshaBalanceSettings, normalizeRoomsByType } from "../utils/marshaBalance";

async function getLatestSnapshot(hotelUid, reportName, onOrBefore) {
  const snapshotsRef = collection(db, `hotels/${hotelUid}/reports/${reportName}/snapshotDates`);
  const result = await getDocs(query(snapshotsRef, orderBy(documentId(), "desc"), limit(10)));
  const candidates = result.docs.filter((item) => item.id <= onOrBefore);
  const selected = candidates[0] || result.docs[0] || null;
  return selected ? { snapshotDate: selected.id, metadata: selected.data() || {} } : null;
}

async function loadSource(hotelUid, reportName, stayDates, today) {
  const snapshot = await getLatestSnapshot(hotelUid, reportName, today);
  if (!snapshot) return { snapshotDate: null, metadata: {}, stays: {} };
  const documents = await Promise.all(stayDates.map(async (stayDate) => {
    const reference = doc(db, `hotels/${hotelUid}/reports/${reportName}/snapshotDates/${snapshot.snapshotDate}/stayDates`, stayDate);
    const result = await getDoc(reference);
    return [stayDate, result.exists() ? { ...result.data(), roomsByType: normalizeRoomsByType(result.data()?.roomsByType) } : null];
  }));
  return { ...snapshot, stays: Object.fromEntries(documents) };
}

export async function getMarshaBalanceData(hotelUid, stayDates, today) {
  const [marsha, opera] = await Promise.all([
    loadSource(hotelUid, "marshaavailability", stayDates, today),
    loadSource(hotelUid, "operaavailability", stayDates, today),
  ]);
  return { marsha, opera };
}

export async function getMarshaBalanceSettings(hotelUid) {
  const result = await getDoc(doc(db, `hotels/${hotelUid}/settings`, "marshaBalance"));
  return result.exists() ? { ...createEmptyMarshaBalanceSettings(), ...result.data() } : createEmptyMarshaBalanceSettings();
}

export function saveMarshaBalanceSettings(hotelUid, settings) {
  return setDoc(doc(db, `hotels/${hotelUid}/settings`, "marshaBalance"), settings);
}
