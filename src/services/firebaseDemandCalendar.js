import { addDoc, collection, db, deleteDoc, doc, getDoc, getDocs, onSnapshot, serverTimestamp, setDoc, updateDoc } from "../firebaseConfig";

// Firestore collections are nested beneath the selected hotel. The extra `categories`
// segment makes the requested settings document a valid Firestore collection parent.
export const demandCalendarEventsPath = (hotelUid) => `hotels/${hotelUid}/demandCalendarEvents`;
export const legacyDemandCalendarEventsPath = (hotelUid) => `hotels/${hotelUid}/reports/demandCalendar/events`;
export const demandCalendarCategoriesPath = (hotelUid) => `hotels/${hotelUid}/settings/demandCalendarCategories/categories`;
const withId = (snapshot) => ({ id: snapshot.id, ...snapshot.data() });

const subscribe = (path, callback, onError) => onSnapshot(collection(db, path), (snapshot) => callback(snapshot.docs.map(withId)), onError);
export const mergeDemandCalendarEvents = (canonical = [], legacy = []) => {
  const merged = new Map([...legacy, ...canonical].map((item) => [item.id, item]));
  return [...merged.values()];
};
export const subscribeDemandCalendarEvents = (hotelUid, callback, onError) => {
  if (!hotelUid) return () => {};
  let canonical = [], legacy = [];
  const emit = () => callback(mergeDemandCalendarEvents(canonical, legacy));
  const unsubscribeCanonical = subscribe(demandCalendarEventsPath(hotelUid), (items) => { canonical = items; emit(); }, onError);
  const unsubscribeLegacy = subscribe(legacyDemandCalendarEventsPath(hotelUid), (items) => { legacy = items; emit(); }, onError);
  return () => { unsubscribeCanonical(); unsubscribeLegacy(); };
};
export const subscribeDemandCalendarCategories = (hotelUid, callback, onError) => hotelUid ? subscribe(demandCalendarCategoriesPath(hotelUid), callback, onError) : () => {};

// Forecast data originally lived under reports; read both locations while hotels migrate
// to the canonical collection documented for the Demand Calendar.
export async function getDemandCalendarEvents(hotelUid) {
  if (!hotelUid) return [];
  const [canonical, legacy] = await Promise.all([
    getDocs(collection(db, demandCalendarEventsPath(hotelUid))),
    getDocs(collection(db, legacyDemandCalendarEventsPath(hotelUid))),
  ]);
  return mergeDemandCalendarEvents(canonical.docs.map(withId), legacy.docs.map(withId));
}

export async function getDemandCalendarEvent(hotelUid, eventId) {
  if (!hotelUid || !eventId) return null;
  const [canonical, legacy] = await Promise.all([
    getDoc(doc(db, demandCalendarEventsPath(hotelUid), eventId)),
    getDoc(doc(db, legacyDemandCalendarEventsPath(hotelUid), eventId)),
  ]);
  const snapshot = canonical.exists() ? canonical : legacy;
  return snapshot.exists() ? withId(snapshot) : null;
}
export async function createDemandCalendarEvent(hotelUid, payload) {
  const result = await addDoc(collection(db, demandCalendarEventsPath(hotelUid)), { ...payload, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  return result.id;
}
export const updateDemandCalendarEvent = (hotelUid, eventId, payload) => setDoc(doc(db, demandCalendarEventsPath(hotelUid), eventId), { ...payload, updatedAt: serverTimestamp() }, { merge: true });
export const deleteDemandCalendarEvent = (hotelUid, eventId) => deleteDoc(doc(db, demandCalendarEventsPath(hotelUid), eventId));
export const createDemandCalendarCategory = async (hotelUid, payload) => (await addDoc(collection(db, demandCalendarCategoriesPath(hotelUid)), { ...payload, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })).id;
export const updateDemandCalendarCategory = (hotelUid, categoryId, payload) => updateDoc(doc(db, demandCalendarCategoriesPath(hotelUid), categoryId), { ...payload, updatedAt: serverTimestamp() });
export const deleteDemandCalendarCategory = (hotelUid, categoryId) => deleteDoc(doc(db, demandCalendarCategoriesPath(hotelUid), categoryId));

export async function importDemandCalendar(hotelUid, { categories, events }) {
  if (!hotelUid) throw new Error("Hotel is required.");
  await Promise.all(categories.map(({ id, ...category }) => setDoc(doc(db, demandCalendarCategoriesPath(hotelUid), id), { ...category, updatedAt: serverTimestamp() })));
  await Promise.all(events.map(({ id, ...event }) => setDoc(doc(db, demandCalendarEventsPath(hotelUid), id), { ...event, updatedAt: serverTimestamp() })));
}
