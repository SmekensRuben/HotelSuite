import {
  addDoc,
  collection,
  db,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from "../firebaseConfig";

const compsetPath = (hotelUid) => `hotels/${hotelUid}/compset`;

const withId = (docSnap) => ({ id: docSnap.id, ...docSnap.data() });

export const subscribeCompset = (hotelUid, callback) => {
  if (!hotelUid) return () => {};
  const ref = collection(db, compsetPath(hotelUid));
  const q = query(ref, orderBy("name"));
  return onSnapshot(q, (snapshot) => callback(snapshot.docs.map(withId)));
};

export const addCompsetHotel = async (hotelUid, { name, rooms }) => {
  if (!hotelUid) throw new Error("Hotel ontbreekt");

  const payload = {
    name: name?.trim() || "Onbenoemd hotel",
    rooms: Number(rooms) || 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  await addDoc(collection(db, compsetPath(hotelUid)), payload);
};
