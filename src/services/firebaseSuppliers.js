import {
  db,
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "../firebaseConfig";

export async function getSuppliers(hotelUid) {
  if (!hotelUid) return [];
  const suppliersCol = collection(db, `hotels/${hotelUid}/suppliers`);
  const snap = await getDocs(suppliersCol);
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

export async function getSupplier(hotelUid, supplierId) {
  if (!hotelUid || !supplierId) return null;
  const supplierDoc = doc(db, `hotels/${hotelUid}/suppliers`, supplierId);
  const snap = await getDoc(supplierDoc);
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

export async function createSupplier(hotelUid, supplierData, actor) {
  if (!hotelUid) throw new Error("hotelUid is verplicht!");
  const suppliersCol = collection(db, `hotels/${hotelUid}/suppliers`);
  const payload = {
    ...supplierData,
    createdAt: serverTimestamp(),
    createdBy: actor || "unknown",
    updatedAt: serverTimestamp(),
    updatedBy: actor || "unknown",
  };
  const docRef = await addDoc(suppliersCol, payload);
  return docRef.id;
}

export async function updateSupplier(hotelUid, supplierId, supplierData, actor) {
  if (!hotelUid || !supplierId) throw new Error("hotelUid en supplierId zijn verplicht!");
  const supplierDoc = doc(db, `hotels/${hotelUid}/suppliers`, supplierId);
  const payload = {
    ...supplierData,
    updatedAt: serverTimestamp(),
    updatedBy: actor || "unknown",
  };
  await updateDoc(supplierDoc, payload);
}

export async function deleteSupplier(hotelUid, supplierId) {
  if (!hotelUid || !supplierId) return;
  const supplierDoc = doc(db, `hotels/${hotelUid}/suppliers`, supplierId);
  await deleteDoc(supplierDoc);
}
