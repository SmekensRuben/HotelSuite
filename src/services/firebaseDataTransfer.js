import { db, collection, getDocs, doc, setDoc, writeBatch, getDoc } from "../firebaseConfig";
import { rebuildArticleMasterIndex } from "./firebaseArticles";
import { rebuildIngredientIndex } from "./firebaseIngredients";
import { rebuildProductMasterIndex } from "./firebaseProducts";

async function copyCollection(fromUid, toUid, colName) {
  const srcCol = collection(db, `hotels/${fromUid}/${colName}`);
  const destCol = collection(db, `hotels/${toUid}/${colName}`);
  const [srcSnap, destSnap] = await Promise.all([
    getDocs(srcCol),
    getDocs(destCol),
  ]);

  const existingIds = new Set(destSnap.docs.map(d => d.id));
  const docs = srcSnap.docs.filter(docSnap => !existingIds.has(docSnap.id));

  for (let i = 0; i < docs.length; i += 500) {
    const batch = writeBatch(db);
    docs.slice(i, i + 500).forEach(docSnap => {
      const destRef = doc(db, `hotels/${toUid}/${colName}`, docSnap.id);
      batch.set(destRef, docSnap.data());
    });
    await batch.commit();
  }
}

export async function transferArticles(fromUid, toUid) {
  if (!fromUid || !toUid) return;
  await copyCollection(fromUid, toUid, "articles");
  await rebuildArticleMasterIndex(toUid);
}

export async function transferIngredients(fromUid, toUid) {
  if (!fromUid || !toUid) return;
  await copyCollection(fromUid, toUid, "ingredients");
  await rebuildIngredientIndex(toUid);
}

export async function transferSettings(fromUid, toUid) {
  if (!fromUid || !toUid) return;
  const srcRef = doc(db, `hotels/${fromUid}/settings`, fromUid);
  const snap = await getDoc(srcRef);
  if (!snap.exists()) return;
  const destRef = doc(db, `hotels/${toUid}/settings`, toUid);
  await setDoc(destRef, snap.data());
}

export async function transferProducts(fromUid, toUid) {
  if (!fromUid || !toUid) return;
  await copyCollection(fromUid, toUid, "products");
  await rebuildProductMasterIndex(toUid);
}

