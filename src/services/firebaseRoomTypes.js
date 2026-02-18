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

const roomTypesPath = (hotelUid) => `hotels/${hotelUid}/roomTypes`;

const withId = (docSnap) => ({ id: docSnap.id, ...docSnap.data() });

export const subscribeRoomTypes = (hotelUid, callback) => {
  if (!hotelUid) return () => {};
  const ref = collection(db, roomTypesPath(hotelUid));
  const q = query(ref, orderBy("name", "asc"));
  return onSnapshot(q, (snapshot) => callback(snapshot.docs.map(withId)));
};

export const addRoomType = async (hotelUid, roomType) => {
  if (!hotelUid) throw new Error("Hotel ontbreekt");
  await addDoc(collection(db, roomTypesPath(hotelUid)), {
    ...roomType,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
};

export const getRoomType = async (hotelUid, roomTypeId) => {
  if (!hotelUid || !roomTypeId) return null;
  const ref = doc(db, `${roomTypesPath(hotelUid)}/${roomTypeId}`);
  const snapshot = await getDoc(ref);
  if (!snapshot.exists()) return null;
  return { id: snapshot.id, ...snapshot.data() };
};

export const updateRoomType = async (hotelUid, roomTypeId, updates) => {
  if (!hotelUid || !roomTypeId) return;
  const ref = doc(db, `${roomTypesPath(hotelUid)}/${roomTypeId}`);
  await updateDoc(ref, { ...updates, updatedAt: serverTimestamp() });
};

export const deleteRoomType = async (hotelUid, roomTypeId) => {
  if (!hotelUid || !roomTypeId) return;
  const ref = doc(db, `${roomTypesPath(hotelUid)}/${roomTypeId}`);
  await deleteDoc(ref);
};
