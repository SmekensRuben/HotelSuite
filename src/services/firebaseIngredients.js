// src/services/firebaseIngredients.js
import {
  db,
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
} from "../firebaseConfig";
import { getSelectedHotelUid } from "../utils/hotelUtils";

// Add a new ingredient with name, unit and linked articles
export async function addIngredient(ingredient) {
  const hotelId = getSelectedHotelUid();
  const ingredientsCol = collection(db, `hotels/${hotelId}/ingredients`);
  await addDoc(ingredientsCol, ingredient);
  await rebuildIngredientIndex(hotelId);
}

// Get all ingredients for the current hotel
export async function getIngredients(hotelUidArg) {
  const hotelId = hotelUidArg || getSelectedHotelUid();
  const ingredientsCol = collection(db, `hotels/${hotelId}/ingredients`);
  const snapshot = await getDocs(ingredientsCol);
  return snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
}

// Get ingredients via the index
export async function getIngredientsIndexed(hotelUidArg) {
  const hotelId = hotelUidArg || getSelectedHotelUid();
  const indexDoc = doc(db, `hotels/${hotelId}/indexes/ingredients`);
  const snap = await getDoc(indexDoc);
  if (!snap.exists()) return [];
  const ingredientMap = snap.data().ingredientMap || {};
  return Object.entries(ingredientMap).map(([id, data]) => ({ id, ...data }));
}

// Update an ingredient
export async function updateIngredient(hotelUid, id, updatedFields) {
  if (!hotelUid || !id) return;
  const ingDoc = doc(db, `hotels/${hotelUid}/ingredients`, id);
  await updateDoc(ingDoc, updatedFields);
  await rebuildIngredientIndex(hotelUid);
}

export async function getIngredient(id) {
  const hotelId = getSelectedHotelUid();
  const ingDoc = doc(db, `hotels/${hotelId}/ingredients`, id);
  const snapshot = await getDoc(ingDoc);
  if (!snapshot.exists()) return null;
  return { id, ...snapshot.data() };
}

export async function deleteIngredient(hotelUid, id) {
  if (!hotelUid || !id) return;
  const ingDoc = doc(db, `hotels/${hotelUid}/ingredients`, id);
  await deleteDoc(ingDoc);
  await rebuildIngredientIndex(hotelUid);
}

export async function rebuildIngredientIndex(hotelUid) {
  if (!hotelUid) throw new Error("hotelUid is verplicht!");
  const ingredientsCol = collection(db, `hotels/${hotelUid}/ingredients`);
  const snapshot = await getDocs(ingredientsCol);
  const ingredientMap = {};
  snapshot.docs.forEach(docSnap => {
    ingredientMap[docSnap.id] = { ...docSnap.data(), id: docSnap.id };
  });
  const indexDoc = doc(db, `hotels/${hotelUid}/indexes/ingredients`);
  if (Object.keys(ingredientMap).length > 0) {
    await setDoc(indexDoc, { ingredientMap });
  } else {
    await deleteDoc(indexDoc);
  }
}
