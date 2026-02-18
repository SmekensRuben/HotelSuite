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
  where,
} from "../firebaseConfig";

const marketSegmentsPath = (hotelUid) => `hotels/${hotelUid}/marketSegments`;
const groupMarketSegmentsPath = (hotelUid) =>
  `hotels/${hotelUid}/groupMarketSegments`;
const subSegmentsPath = (hotelUid) => `hotels/${hotelUid}/subSegments`;

const withId = (snapshot) => ({ id: snapshot.id, ...snapshot.data() });
const sortByName = (items) =>
  [...items].sort((a, b) =>
    (a?.name || "").localeCompare(b?.name || "", undefined, {
      sensitivity: "base",
    })
  );

export const subscribeMarketSegments = (hotelUid, callback) => {
  if (!hotelUid) return () => {};
  const ref = collection(db, marketSegmentsPath(hotelUid));
  const q = query(ref, orderBy("name"));
  return onSnapshot(q, (snap) => callback(sortByName(snap.docs.map(withId))));
};

export const subscribeSubSegments = (
  hotelUid,
  callback,
  { marketSegmentId } = {}
) => {
  if (!hotelUid) return () => {};
  const ref = collection(db, subSegmentsPath(hotelUid));
  const constraints = [];

  if (marketSegmentId) {
    constraints.push(where("marketSegmentId", "==", marketSegmentId));
  } else {
    constraints.push(orderBy("name"));
  }

  const q = constraints.length ? query(ref, ...constraints) : ref;
  return onSnapshot(q, (snap) => callback(sortByName(snap.docs.map(withId))));
};

export const subscribeGroupMarketSegments = (hotelUid, callback) => {
  if (!hotelUid) return () => {};
  const ref = collection(db, groupMarketSegmentsPath(hotelUid));
  const q = query(ref, orderBy("name"));
  return onSnapshot(q, (snap) => callback(sortByName(snap.docs.map(withId))));
};

export const getMarketSegment = async (hotelUid, segmentId) => {
  if (!hotelUid || !segmentId) return null;
  const snap = await getDoc(doc(db, marketSegmentsPath(hotelUid), segmentId));
  return snap.exists() ? withId(snap) : null;
};

export const getGroupMarketSegment = async (hotelUid, segmentId) => {
  if (!hotelUid || !segmentId) return null;
  const snap = await getDoc(
    doc(db, groupMarketSegmentsPath(hotelUid), segmentId)
  );
  return snap.exists() ? withId(snap) : null;
};

export const getSubSegment = async (hotelUid, subSegmentId) => {
  if (!hotelUid || !subSegmentId) return null;
  const snap = await getDoc(doc(db, subSegmentsPath(hotelUid), subSegmentId));
  return snap.exists() ? withId(snap) : null;
};

export const saveMarketSegment = async (hotelUid, segmentId, data) => {
  if (!hotelUid) throw new Error("Hotel ontbreekt");
  const type = ["Transient", "Group"].includes(data.type)
    ? data.type
    : "Transient";
  const payload = {
    name: data.name || "",
    type,
    rateCategoryCode: data.rateCategoryCode || "",
    marketSegmentCode: data.marketSegmentCode || "",
    marketSegmentCodes: Array.isArray(data.marketSegmentCodes)
      ? data.marketSegmentCodes
      : data.marketSegmentCode
        ? [data.marketSegmentCode]
        : [],
    countTowardsAdr: data.countTowardsAdr ?? true,
    updatedAt: serverTimestamp(),
  };

  if (segmentId && segmentId !== "new") {
    await updateDoc(doc(db, marketSegmentsPath(hotelUid), segmentId), payload);
    return segmentId;
  }

  const docRef = await addDoc(collection(db, marketSegmentsPath(hotelUid)), {
    ...payload,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
};

export const saveGroupMarketSegment = async (hotelUid, segmentId, data) => {
  if (!hotelUid) throw new Error("Hotel ontbreekt");
  const payload = {
    name: data.name || "",
    marketSegmentIds: Array.isArray(data.marketSegmentIds)
      ? data.marketSegmentIds
      : [],
    marketSegmentNames: Array.isArray(data.marketSegmentNames)
      ? data.marketSegmentNames
      : [],
    updatedAt: serverTimestamp(),
  };

  if (segmentId && segmentId !== "new") {
    await updateDoc(doc(db, groupMarketSegmentsPath(hotelUid), segmentId), payload);
    return segmentId;
  }

  const docRef = await addDoc(collection(db, groupMarketSegmentsPath(hotelUid)), {
    ...payload,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
};

export const saveSubSegment = async (hotelUid, subSegmentId, data) => {
  if (!hotelUid) throw new Error("Hotel ontbreekt");
  const payload = {
    name: data.name || "",
    prefix: data.prefix || "",
    rateType: data.rateType || "",
    description: data.description || "",
    marketSegmentId: data.marketSegmentId || "",
    marketSegmentName: data.marketSegmentName || "",
    updatedAt: serverTimestamp(),
  };

  if (subSegmentId && subSegmentId !== "new") {
    await updateDoc(doc(db, subSegmentsPath(hotelUid), subSegmentId), payload);
    return subSegmentId;
  }

  const docRef = await addDoc(collection(db, subSegmentsPath(hotelUid)), {
    ...payload,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
};

export const deleteMarketSegment = async (hotelUid, segmentId) => {
  if (!hotelUid || !segmentId) throw new Error("Market segment ontbreekt");
  await deleteDoc(doc(db, marketSegmentsPath(hotelUid), segmentId));
};

export const deleteGroupMarketSegment = async (hotelUid, segmentId) => {
  if (!hotelUid || !segmentId) throw new Error("Group market segment ontbreekt");
  await deleteDoc(doc(db, groupMarketSegmentsPath(hotelUid), segmentId));
};

export const deleteSubSegment = async (hotelUid, subSegmentId) => {
  if (!hotelUid || !subSegmentId) throw new Error("Sub segment ontbreekt");
  await deleteDoc(doc(db, subSegmentsPath(hotelUid), subSegmentId));
};
