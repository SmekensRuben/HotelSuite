import {
  collection,
  db,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  writeBatch,
} from "../firebaseConfig";

const marketSegmentsPath = (hotelUid) =>
  `hotels/${hotelUid}/settings/propertySettings/marketSegments`;

const marketSegmentRef = (hotelUid, prefix) =>
  doc(db, marketSegmentsPath(hotelUid), prefix);
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
  const ref = marketSegmentRef(hotelUid, marketSegment.prefix);
  if ((await getDoc(ref)).exists()) {
    throw new Error(`Market Segment ${marketSegment.prefix} already exists.`);
  }

  await setDoc(ref, {
    ...marketSegment,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return marketSegment.prefix;
};

export const updateMarketSegment = async (hotelUid, currentPrefix, marketSegment) => {
  if (!hotelUid || !currentPrefix) throw new Error("Market Segment is missing.");
  const currentRef = marketSegmentRef(hotelUid, currentPrefix);
  const nextRef = marketSegmentRef(hotelUid, marketSegment.prefix);
  const currentSnapshot = await getDoc(currentRef);
  if (!currentSnapshot.exists()) throw new Error("Market Segment no longer exists.");

  if (marketSegment.prefix !== currentPrefix && (await getDoc(nextRef)).exists()) {
    throw new Error(`Market Segment ${marketSegment.prefix} already exists.`);
  }

  const batch = writeBatch(db);
  batch.set(nextRef, {
    ...marketSegment,
    createdAt: currentSnapshot.data().createdAt || serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  if (marketSegment.prefix !== currentPrefix) batch.delete(currentRef);
  await batch.commit();
  return marketSegment.prefix;
};

export const deleteMarketSegment = async (hotelUid, prefix) => {
  if (!hotelUid || !prefix) return;
  await deleteDoc(marketSegmentRef(hotelUid, prefix));
};
