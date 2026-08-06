import { collection, db, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc } from "../firebaseConfig";
import { normalizeNotificationSelections } from "../constants/groupNotifications";

const listsPath = (hotelUid) => `hotels/${hotelUid}/notificationLists`;

function sanitizeContacts(contacts) {
  return (Array.isArray(contacts) ? contacts : [])
    .map((contact) => ({ name: String(contact?.name || "").trim(), email: String(contact?.email || "").trim() }))
    .filter((contact) => contact.name && contact.email);
}

export async function getNotificationLists(hotelUid) {
  if (!hotelUid) return [];
  const snapshot = await getDocs(collection(db, listsPath(hotelUid)));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.title.localeCompare(b.title));
}

export async function saveNotificationList(hotelUid, list, actor) {
  if (!hotelUid) throw new Error("hotelUid is required");
  const reference = list.id ? doc(db, listsPath(hotelUid), list.id) : doc(collection(db, listsPath(hotelUid)));
  await setDoc(reference, {
    title: String(list.title || "").trim(),
    contacts: sanitizeContacts(list.contacts),
    updatedAt: serverTimestamp(),
    updatedBy: actor || "unknown",
  }, { merge: true });
  return reference.id;
}

export async function deleteNotificationList(hotelUid, listId) {
  await deleteDoc(doc(db, listsPath(hotelUid), listId));
}

export async function getGroupNotificationDefaults(hotelUid) {
  if (!hotelUid) return normalizeNotificationSelections();
  const snapshot = await getDoc(doc(db, `hotels/${hotelUid}/groupSettings`, "notifications"));
  return normalizeNotificationSelections(snapshot.exists() ? snapshot.data().defaultNotificationLists : {});
}

export async function saveGroupNotificationDefaults(hotelUid, selections, actor) {
  await setDoc(doc(db, `hotels/${hotelUid}/groupSettings`, "notifications"), {
    defaultNotificationLists: normalizeNotificationSelections(selections),
    updatedAt: serverTimestamp(),
    updatedBy: actor || "unknown",
  }, { merge: true });
}
