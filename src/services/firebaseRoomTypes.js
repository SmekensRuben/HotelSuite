import {
  addDoc,
  collection,
  db,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
} from "../firebaseConfig";

const roomTypesPath = (hotelUid) =>
  `hotels/${hotelUid}/settings/propertySettings/roomTypes`;

const withId = (docSnap) => ({ id: docSnap.id, ...docSnap.data() });

export const subscribeRoomTypes = (hotelUid, callback, onError) => {
  if (!hotelUid) return () => {};
  const ref = collection(db, roomTypesPath(hotelUid));
  return onSnapshot(
    ref,
    (snapshot) => callback(snapshot.docs.map(withId).sort((a, b) =>
      String(a.code || "").localeCompare(String(b.code || ""), undefined, { sensitivity: "base", numeric: true })
    )),
    onError
  );
};

export const addRoomType = async (hotelUid, roomType) => {
  if (!hotelUid) throw new Error("Hotel ontbreekt");
  const ref = await addDoc(collection(db, roomTypesPath(hotelUid)), {
    ...roomType,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
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
