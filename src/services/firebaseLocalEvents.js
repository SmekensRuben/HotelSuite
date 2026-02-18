import {
  addDoc,
  collection,
  db,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "../firebaseConfig";
import { getSelectedHotelUid } from "../utils/hotelUtils";

export function subscribeToLocalEvents(callback) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid) return () => {};

  const eventsRef = collection(db, `hotels/${hotelUid}/localEvents`);
  const q = query(eventsRef, orderBy("startDate", "asc"));

  return onSnapshot(q, (snapshot) => {
    const events = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    callback(events);
  });
}

export async function addLocalEvent(event) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid) {
    throw new Error("No hotel selected");
  }

  const eventsRef = collection(db, `hotels/${hotelUid}/localEvents`);
  await addDoc(eventsRef, {
    ...event,
    createdAt: serverTimestamp(),
  });
}

export async function getLocalEvent(eventId) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid) {
    throw new Error("No hotel selected");
  }

  const eventRef = doc(db, `hotels/${hotelUid}/localEvents/${eventId}`);
  const snapshot = await getDoc(eventRef);
  if (!snapshot.exists()) {
    return null;
  }

  return { id: snapshot.id, ...snapshot.data() };
}

export async function updateLocalEvent(eventId, updates) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid) {
    throw new Error("No hotel selected");
  }

  const eventRef = doc(db, `hotels/${hotelUid}/localEvents/${eventId}`);
  await updateDoc(eventRef, updates);
}

export async function deleteLocalEvent(eventId) {
  const hotelUid = getSelectedHotelUid();
  if (!hotelUid) {
    throw new Error("No hotel selected");
  }

  const eventRef = doc(db, `hotels/${hotelUid}/localEvents/${eventId}`);
  await deleteDoc(eventRef);
}
