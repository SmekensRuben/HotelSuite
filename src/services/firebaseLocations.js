import { db, collection, addDoc, deleteDoc, getDocs } from "../firebaseConfig";
import { getSelectedHotelUid } from "../utils/hotelUtils";

// Haal alle locaties op
export async function getLocations() {
  const hotelUid = getSelectedHotelUid();
  const locationsCol = collection(db, `hotels/${hotelUid}/locations`);
  const snapshot = await getDocs(locationsCol);
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// Voeg locatie toe
export async function addLocation(name) {
  const hotelUid = getSelectedHotelUid();
  const locationsCol = collection(db, `hotels/${hotelUid}/locations`);
  await addDoc(locationsCol, { name });
}

// Verwijder locatie
export async function deleteLocation(id) {
  const hotelUid = getSelectedHotelUid();
  const docRef = doc(db, `hotels/${hotelUid}/locations`, id);
  await deleteDoc(docRef);
}
