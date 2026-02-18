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

const roomClassesPath = (hotelUid) => `hotels/${hotelUid}/roomClasses`;

const withId = (docSnap) => ({ id: docSnap.id, ...docSnap.data() });

export const subscribeRoomClasses = (hotelUid, callback) => {
  if (!hotelUid) return () => {};
  const ref = collection(db, roomClassesPath(hotelUid));
  const q = query(ref, orderBy("code", "asc"));
  return onSnapshot(q, (snapshot) => callback(snapshot.docs.map(withId)));
};

export const addRoomClass = async (hotelUid, roomClass) => {
  if (!hotelUid) throw new Error("Hotel ontbreekt");
  await addDoc(collection(db, roomClassesPath(hotelUid)), {
    ...roomClass,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
};

export const getRoomClass = async (hotelUid, roomClassId) => {
  if (!hotelUid || !roomClassId) return null;
  const ref = doc(db, `${roomClassesPath(hotelUid)}/${roomClassId}`);
  const snapshot = await getDoc(ref);
  if (!snapshot.exists()) return null;
  return { id: snapshot.id, ...snapshot.data() };
};

export const updateRoomClass = async (hotelUid, roomClassId, updates) => {
  if (!hotelUid || !roomClassId) return;
  const ref = doc(db, `${roomClassesPath(hotelUid)}/${roomClassId}`);
  await updateDoc(ref, { ...updates, updatedAt: serverTimestamp() });
};

export const deleteRoomClass = async (hotelUid, roomClassId) => {
  if (!hotelUid || !roomClassId) return;
  const ref = doc(db, `${roomClassesPath(hotelUid)}/${roomClassId}`);
  await deleteDoc(ref);
};
