// services/firebaseRebateAgreements.js
import { db } from "../firebaseConfig";
import { collection, addDoc, doc, setDoc, getDoc, getDocs, deleteDoc } from "firebase/firestore";

function must(v, name){ if (!v && v !== 0) throw new Error(`${name} missing`); return String(v).trim(); }

export async function getRebateAgreements(hotelUid) {
  const uid = must(hotelUid, "hotelUid");
  const snap = await getDocs(collection(db, "hotels", uid, "rebateAgreements"));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getRebateAgreement(hotelUid, id) {
  const uid = must(hotelUid, "hotelUid"); const _id = must(id, "id");
  const d = await getDoc(doc(db, "hotels", uid, "rebateAgreements", _id));
  return d.exists() ? { id: d.id, ...d.data() } : null;
}

export async function addRebateAgreement(hotelUid, payload) {
  const uid = must(hotelUid, "hotelUid");
  const ref = await addDoc(collection(db, "hotels", uid, "rebateAgreements"), payload);
  return ref.id;
}

export async function updateRebateAgreement(hotelUid, id, payload) {
  const uid = must(hotelUid, "hotelUid"); const _id = must(id, "id");
  const ref = doc(db, "hotels", uid, "rebateAgreements", _id);
  await setDoc(ref, payload, { merge: true });
}

export async function deleteRebateAgreement(hotelUid, id) {
  const uid = must(hotelUid, "hotelUid"); const _id = must(id, "id");
  await deleteDoc(doc(db, "hotels", uid, "rebateAgreements", _id));
}
