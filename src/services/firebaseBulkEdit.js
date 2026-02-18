import {
  db,
  collection,
  getDocs,
  writeBatch
} from "../firebaseConfig";
import { getSelectedHotelUid } from "../utils/hotelUtils";

// Haal alle veldnamen op voor een gegeven entiteit
export async function getEntityFields(entity, hotelUidArg) {
  const hotelUid = hotelUidArg || getSelectedHotelUid();
  if (!hotelUid || !entity) return [];
  const col = collection(db, `hotels/${hotelUid}/${entity}`);
  const snapshot = await getDocs(col);
  const fields = new Set();
  snapshot.forEach(docSnap => {
    const data = docSnap.data() || {};
    Object.keys(data).forEach(key => fields.add(key));
  });
  return Array.from(fields);
}

// Maak alle waarden van een veld leeg voor een entiteit
export async function clearEntityField(entity, field, hotelUidArg) {
  const hotelUid = hotelUidArg || getSelectedHotelUid();
  if (!hotelUid || !entity || !field) return;
  const col = collection(db, `hotels/${hotelUid}/${entity}`);
  const snapshot = await getDocs(col);
  if (snapshot.empty) return;
  const batch = writeBatch(db);
  snapshot.forEach(docSnap => {
    batch.update(docSnap.ref, { [field]: null });
  });
  await batch.commit();
}
