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

const quotesPath = (hotelUid) => `hotels/${hotelUid}/quotes`;

const withId = (docSnap) => ({ id: docSnap.id, ...docSnap.data() });

export const subscribeQuotes = (hotelUid, callback) => {
  if (!hotelUid) return () => {};
  const ref = collection(db, quotesPath(hotelUid));
  return onSnapshot(ref, (snapshot) => {
    const quotes = snapshot.docs.map(withId).sort((left, right) =>
      String(right.startDate || right.quoteDate || "").localeCompare(
        String(left.startDate || left.quoteDate || "")
      )
    );
    callback(quotes);
  });
};

export const addQuote = async (hotelUid, quote) => {
  if (!hotelUid) throw new Error("Hotel ontbreekt");
  const document = await addDoc(collection(db, quotesPath(hotelUid)), {
    ...quote,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return document.id;
};

export const getQuote = async (hotelUid, quoteId) => {
  if (!hotelUid || !quoteId) return null;
  const ref = doc(db, `${quotesPath(hotelUid)}/${quoteId}`);
  const snapshot = await getDoc(ref);
  if (!snapshot.exists()) return null;
  return { id: snapshot.id, ...snapshot.data() };
};

export const updateQuote = async (hotelUid, quoteId, updates) => {
  if (!hotelUid || !quoteId) return;
  const ref = doc(db, `${quotesPath(hotelUid)}/${quoteId}`);
  await updateDoc(ref, { ...updates, updatedAt: serverTimestamp() });
};

export const deleteQuote = async (hotelUid, quoteId) => {
  if (!hotelUid || !quoteId) return;
  const ref = doc(db, `${quotesPath(hotelUid)}/${quoteId}`);
  await deleteDoc(ref);
};
