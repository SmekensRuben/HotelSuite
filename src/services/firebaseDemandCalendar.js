import { addDoc, collection, db, deleteDoc, doc, getDoc, onSnapshot, serverTimestamp, updateDoc } from "../firebaseConfig";

// Firestore collections are nested beneath the selected hotel. The extra `categories`
// segment makes the requested settings document a valid Firestore collection parent.
export const demandCalendarEventsPath = (hotelUid) => `hotels/${hotelUid}/reports/demandCalendar/events`;
export const demandCalendarCategoriesPath = (hotelUid) => `hotels/${hotelUid}/settings/demandCalendarCategories/categories`;
const withId = (snapshot) => ({ id: snapshot.id, ...snapshot.data() });

const subscribe = (path, callback, onError) => onSnapshot(collection(db, path), (snapshot) => callback(snapshot.docs.map(withId)), onError);
export const subscribeDemandCalendarEvents = (hotelUid, callback, onError) => hotelUid ? subscribe(demandCalendarEventsPath(hotelUid), callback, onError) : () => {};
export const subscribeDemandCalendarCategories = (hotelUid, callback, onError) => hotelUid ? subscribe(demandCalendarCategoriesPath(hotelUid), callback, onError) : () => {};

export async function getDemandCalendarEvent(hotelUid, eventId) {
  if (!hotelUid || !eventId) return null;
  const snapshot = await getDoc(doc(db, demandCalendarEventsPath(hotelUid), eventId));
  return snapshot.exists() ? withId(snapshot) : null;
}
export async function createDemandCalendarEvent(hotelUid, payload) {
  const result = await addDoc(collection(db, demandCalendarEventsPath(hotelUid)), { ...payload, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  return result.id;
}
export const updateDemandCalendarEvent = (hotelUid, eventId, payload) => updateDoc(doc(db, demandCalendarEventsPath(hotelUid), eventId), { ...payload, updatedAt: serverTimestamp() });
export const deleteDemandCalendarEvent = (hotelUid, eventId) => deleteDoc(doc(db, demandCalendarEventsPath(hotelUid), eventId));
export const createDemandCalendarCategory = async (hotelUid, payload) => (await addDoc(collection(db, demandCalendarCategoriesPath(hotelUid)), { ...payload, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })).id;
export const updateDemandCalendarCategory = (hotelUid, categoryId, payload) => updateDoc(doc(db, demandCalendarCategoriesPath(hotelUid), categoryId), { ...payload, updatedAt: serverTimestamp() });
export const deleteDemandCalendarCategory = (hotelUid, categoryId) => deleteDoc(doc(db, demandCalendarCategoriesPath(hotelUid), categoryId));
