// src/services/firebaseReturns.js
import {
  db,
  collection,
  doc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc
} from "../firebaseConfig";

/**
 * Haal alle retouren op voor het actieve hotel
 * @returns {Promise<Array>} Lijst van retouren [{id, ...}]
 */
export async function getReturns(hotelUid) {
  if (!hotelUid) return [];
  const returnsCol = collection(db, `hotels/${hotelUid}/returns`);
  const snap = await getDocs(returnsCol);
  return snap.docs.map(docSnap => ({
    ...docSnap.data(),
    id: docSnap.id
  }));
}

/**
 * Voeg een nieuwe retour toe
 * @param {Object} retourData
 */
export async function addReturn(hotelUid, retourData) {
  if (!hotelUid) return null;
  const returnsCol = collection(db, `hotels/${hotelUid}/returns`);
  const docRef = await addDoc(returnsCol, retourData);
  return docRef.id;
}

/**
 * Update een bestaande retour
 * @param {string} hotelUid
 * @param {string} retourId
 * @param {Object} fields
 */
export async function updateReturn(hotelUid, retourId, fields) {
  if (!hotelUid || !retourId) return;
  const retourDoc = doc(db, `hotels/${hotelUid}/returns`, retourId);
  await updateDoc(retourDoc, fields);
}

/**
 * Verwijder een retour (optioneel)
 */
export async function deleteReturn(hotelUid, retourId) {
  if (!hotelUid || !retourId) return;
  const retourDoc = doc(db, `hotels/${hotelUid}/returns`, retourId);
  await deleteDoc(retourDoc);
}
