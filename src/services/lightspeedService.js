import { db, collection, addDoc, getDocs } from "../firebaseConfig";

// Lijst van imports ophalen (nieuw naar oud)
export async function getLightspeedImports(hotelUid) {
  if (!hotelUid) return [];
  const importsCol = collection(db, `hotels/${hotelUid}/lightspeedImports`);
  const snap = await getDocs(importsCol);
  // Converteer naar array & sorteer op importDate (nieuw naar oud)
  return snap.docs
    .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
    .sort((a, b) => (b.importDate || "").localeCompare(a.importDate || ""));
}

// Nieuwe import toevoegen
export async function addLightspeedImport(hotelUid, importObj) {
  if (!hotelUid) return;
  const importsCol = collection(db, `hotels/${hotelUid}/lightspeedImports`);
  await addDoc(importsCol, importObj);
}
