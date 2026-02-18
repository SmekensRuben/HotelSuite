import {
  db,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  getDoc,
  query,
  where
} from "../firebaseConfig";
import { getIngredientsIndexed } from "./firebaseIngredients";

async function validateIngredients(hotelUid, composition = []) {
  if (!hotelUid || !Array.isArray(composition)) return;
  const ingredients = await getIngredientsIndexed(hotelUid);
  const validIds = new Set(ingredients.map(i => i.id));
  const invalid = composition.find(row => !validIds.has(row.ingredientId));
  if (invalid) {
    throw new Error(`Invalid ingredient ID: ${invalid.ingredientId}`);
  }
}

const recipesIndexedCache = {};

export function clearRecipesIndexedCache(hotelUid) {
  if (hotelUid) {
    delete recipesIndexedCache[hotelUid];
  }
}

export async function getRecipes(hotelUid) {
  if (!hotelUid) return [];
  const col = collection(db, `hotels/${hotelUid}/recipes`);
  const snap = await getDocs(col);
  return snap.docs.map(docSnap => ({ ...docSnap.data(), id: docSnap.id }));
}

export async function addRecipe(hotelUid, data) {
  if (!hotelUid) return;
  await validateIngredients(hotelUid, data.composition);
  const col = collection(db, `hotels/${hotelUid}/recipes`);
  const recipeData = { ...data, category: data.category ?? "" };
  await addDoc(col, recipeData);
  await rebuildRecipeCategoryIndex(hotelUid, recipeData.category);
  clearRecipesIndexedCache(hotelUid);
}

export async function updateRecipe(hotelUid, id, data) {
  if (!hotelUid || !id) return;
  await validateIngredients(hotelUid, data.composition);
  const docRef = doc(db, `hotels/${hotelUid}/recipes`, id);
  const snap = await getDoc(docRef);
  let oldCategory = "";
  if (snap.exists()) {
    oldCategory = snap.data().category || "";
  }
  await updateDoc(docRef, data);
  const newCategory = data.category !== undefined ? data.category : oldCategory;
  await rebuildRecipeCategoryIndex(hotelUid, newCategory);
  if (oldCategory !== newCategory) {
    await rebuildRecipeCategoryIndex(hotelUid, oldCategory);
  }
  clearRecipesIndexedCache(hotelUid);
}

export async function deleteRecipe(hotelUid, id) {
  if (!hotelUid || !id) return;
  const docRef = doc(db, `hotels/${hotelUid}/recipes`, id);
  const snap = await getDoc(docRef);
  const category = snap.exists() ? snap.data().category || "" : "";
  await deleteDoc(docRef);
  await rebuildRecipeCategoryIndex(hotelUid, category);
  clearRecipesIndexedCache(hotelUid);
}

export async function rebuildRecipeMasterIndex(hotelUid) {
  if (!hotelUid) return;
  const colRef = collection(db, `hotels/${hotelUid}/recipes`);
  const snapshot = await getDocs(colRef);
  const categoriesSet = new Set();
  snapshot.docs.forEach(docSnap => {
    const data = docSnap.data();
    categoriesSet.add(data.category || "_uncategorized");
  });
  for (const catId of categoriesSet) {
    await rebuildRecipeCategoryIndex(hotelUid, catId);
  }
  clearRecipesIndexedCache(hotelUid);
}

export async function getRecipesIndexed(hotelUid) {
  if (!hotelUid) return [];
  if (recipesIndexedCache[hotelUid]) {
    return recipesIndexedCache[hotelUid];
  }
  const indexCol = collection(
    db,
    `hotels/${hotelUid}/indexes/recipeMasterIndex/recipesPerCategory`
  );
  const snapshot = await getDocs(indexCol);
  const result = [];
  snapshot.docs.forEach(docSnap => {
    const map = docSnap.data().recipeMap || {};
    Object.entries(map).forEach(([id, data]) => {
      result.push({ ...data, id });
    });
  });
  recipesIndexedCache[hotelUid] = result;
  return result;
}

export async function rebuildRecipeCategoryIndex(hotelUid, categoryId) {
  if (!hotelUid) throw new Error("hotelUid is verplicht!");
  const cat = categoryId || "";
  const recipesCol = collection(db, `hotels/${hotelUid}/recipes`);
  const q = query(recipesCol, where("category", "==", cat));
  const snapshot = await getDocs(q);
  const recipeMap = {};
  snapshot.docs.forEach(docSnap => {
    const data = docSnap.data();
    recipeMap[docSnap.id] = { ...data, id: docSnap.id };
  });
  const indexCol = collection(
    db,
    `hotels/${hotelUid}/indexes/recipeMasterIndex/recipesPerCategory`
  );
  const docId = cat || "_uncategorized";
  const ref = doc(indexCol, docId);
  if (Object.keys(recipeMap).length > 0) {
    await setDoc(ref, { recipeMap });
  } else {
    await deleteDoc(ref);
  }
  clearRecipesIndexedCache(hotelUid);
}
