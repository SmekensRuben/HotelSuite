import { db, doc, getDoc, setDoc } from "../firebaseConfig";

export async function getRevenue(hotelUid, day) {
  if (!hotelUid || !day) return {};
  const ref = doc(db, `hotels/${hotelUid}/revenue`, day);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : {};
}

export async function setRevenue(hotelUid, day, data) {
  if (!hotelUid || !day) {
    console.warn("setRevenue called without hotelUid or day", { hotelUid, day });
    return;
  }
  const ref = doc(db, `hotels/${hotelUid}/revenue`, day);
  console.debug("Writing revenue", { hotelUid, day, data });
  try {
    await setDoc(ref, data);
  } catch (err) {
    console.error("Failed to write revenue", err);
    throw err;
  }
}
