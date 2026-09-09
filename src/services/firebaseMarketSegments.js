import {
  addDoc,
  collection,
  db,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
} from "../firebaseConfig";

const marketSegmentsPath = (hotelUid) =>
  `hotels/${hotelUid}/settings/propertySettings/marketSegments`;

const marketSegmentRef = (hotelUid, id) =>
  doc(db, marketSegmentsPath(hotelUid), id);
const withId = (snapshot) => ({ id: snapshot.id, ...snapshot.data() });

export const subscribeMarketSegments = (hotelUid, callback, onError) => {
  if (!hotelUid) return () => {};

  return onSnapshot(
    collection(db, marketSegmentsPath(hotelUid)),
    (snapshot) => callback(snapshot.docs.map(withId)),
    onError
  );
};

export const addMarketSegment = async (hotelUid, marketSegment) => {
  if (!hotelUid) throw new Error("Hotel is missing.");

  const ref = await addDoc(collection(db, marketSegmentsPath(hotelUid)), {
    ...marketSegment,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
};

export const updateMarketSegment = async (hotelUid, id, marketSegment) => {
  if (!hotelUid || !id) throw new Error("Market Segment is missing.");
  await updateDoc(marketSegmentRef(hotelUid, id), {
    ...marketSegment,
    updatedAt: serverTimestamp(),
  });
};

export const deleteMarketSegment = async (hotelUid, id) => {
  if (!hotelUid || !id) return;
  await deleteDoc(marketSegmentRef(hotelUid, id));
};
