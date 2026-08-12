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

const rateCodesPath = (hotelUid) =>
  `hotels/${hotelUid}/settings/propertySettings/rateCodes`;

const rateCodeId = ({ prefix, code }) => `${prefix}${code}`;
const rateCodeRef = (hotelUid, id) => doc(db, rateCodesPath(hotelUid), id);
const withId = (snapshot) => ({ id: snapshot.id, ...snapshot.data() });

export const subscribeRateCodes = (hotelUid, callback, onError) => {
  if (!hotelUid) return () => {};

  return onSnapshot(
    collection(db, rateCodesPath(hotelUid)),
    (snapshot) => callback(snapshot.docs.map(withId)),
    onError
  );
};

export const addRateCode = async (hotelUid, rateCode) => {
  if (!hotelUid) throw new Error("Hotel is missing.");
  const id = rateCodeId(rateCode);
  const ref = rateCodeRef(hotelUid, id);
  if ((await getDoc(ref)).exists()) {
    throw new Error(`Rate Code ${id} already exists.`);
  }

  await setDoc(ref, {
    ...rateCode,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return id;
};

export const updateRateCode = async (hotelUid, currentId, rateCode) => {
  if (!hotelUid || !currentId) throw new Error("Rate Code is missing.");
  const nextId = rateCodeId(rateCode);
  const currentRef = rateCodeRef(hotelUid, currentId);
  const nextRef = rateCodeRef(hotelUid, nextId);
  const currentSnapshot = await getDoc(currentRef);
  if (!currentSnapshot.exists()) throw new Error("Rate Code no longer exists.");

  if (nextId !== currentId && (await getDoc(nextRef)).exists()) {
    throw new Error(`Rate Code ${nextId} already exists.`);
  }

  const batch = writeBatch(db);
  batch.set(nextRef, {
    ...rateCode,
    createdAt: currentSnapshot.data().createdAt || serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  if (nextId !== currentId) batch.delete(currentRef);
  await batch.commit();
  return nextId;
};

export const deleteRateCode = async (hotelUid, id) => {
  if (!hotelUid || !id) return;
  await deleteDoc(rateCodeRef(hotelUid, id));
};
