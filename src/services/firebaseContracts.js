import {
  db,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  serverTimestamp,
  storage,
  ref,
  uploadBytes,
  getDownloadURL,
} from "../firebaseConfig";

export async function getContracts(hotelUid) {
  if (!hotelUid) return [];
  const contractsCol = collection(db, `hotels/${hotelUid}/contracts`);
  const snap = await getDocs(contractsCol);
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

export async function getContract(hotelUid, contractId) {
  if (!hotelUid || !contractId) return null;
  const contractDoc = doc(db, `hotels/${hotelUid}/contracts`, contractId);
  const snap = await getDoc(contractDoc);
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

async function uploadContractFile(hotelUid, contractId, file) {
  const safeFileName = file.name.replace(/\s+/g, "-");
  const filePath = `hotels/${hotelUid}/contracts/${contractId}/${Date.now()}-${safeFileName}`;
  const fileRef = ref(storage, filePath);
  await uploadBytes(fileRef, file);
  const downloadUrl = await getDownloadURL(fileRef);
  return {
    fileName: file.name,
    filePath,
    downloadUrl,
  };
}

export async function createContract(hotelUid, contractData, contractFile, actor) {
  if (!hotelUid) throw new Error("hotelUid is verplicht!");

  const contractsCol = collection(db, `hotels/${hotelUid}/contracts`);
  const contractDocRef = doc(contractsCol);

  let fileMeta = null;
  if (contractFile) {
    fileMeta = await uploadContractFile(hotelUid, contractDocRef.id, contractFile);
  }

  const payload = {
    ...contractData,
    contractFile: fileMeta,
    createdAt: serverTimestamp(),
    createdBy: actor || "unknown",
    updatedAt: serverTimestamp(),
    updatedBy: actor || "unknown",
  };

  await setDoc(contractDocRef, payload);
  return contractDocRef.id;
}
