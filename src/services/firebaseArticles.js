// src/services/firebaseArticles.js
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
  writeBatch,
  query,
  where,
  orderBy
} from "../firebaseConfig";
import { getSelectedHotelUid } from "../utils/hotelUtils";
import { getIngredients } from "./firebaseIngredients";

// Voeg een ingrediënt toe (zet altijd lastPriceUpdate indien prijs gezet wordt)
export async function addArticle(article) {
  const hotelId = getSelectedHotelUid();
  const articlesCol = collection(db, `hotels/${hotelId}/articles`);
  const now = Date.now();
  const docRef = await addDoc(articlesCol, {
    ...article,
    ean: article.ean || "",
    frozen: article.frozen ?? false,
    aliases: article.aliases || { en: "", fr: "", nl: "" },
    lastPriceUpdate: article.pricePerPurchaseUnit ? now : null,
  });
  if (article.pricePerPurchaseUnit) {
    const historyCol = collection(
      db,
      `hotels/${hotelId}/articles/${docRef.id}/priceHistory`
    );
    await addDoc(historyCol, {
      price: Number(article.pricePerPurchaseUnit),
      date: now,
    });
  }
  await rebuildArticleCategoryIndex(hotelId, article.category || "");
  return docRef.id;
}

// Haal alle ingrediënten op voor het huidige hotel
export async function getArticles(hotelUidArg) {
  const hotelId = hotelUidArg || getSelectedHotelUid();
  const articlesCol = collection(db, `hotels/${hotelId}/articles`);
  const snapshot = await getDocs(articlesCol);
  return snapshot.docs.map(docSnap => {
    const value = docSnap.data();
    return {
      id: docSnap.id,
      name: value.name || "",
      brand: value.brand || "",
      supplier: value.supplier || "",
      purchaseUnit: value.purchaseUnit || "",
      unitsPerPurchaseUnit: value.unitsPerPurchaseUnit || 0,
      stockUnit: value.stockUnit || "",
      pricePerPurchaseUnit: value.pricePerPurchaseUnit || 0,
      pricePerStockUnit: value.pricePerStockUnit || 0,
      recipeUnit: value.recipeUnit || "",
      contentPerStockUnit: value.contentPerStockUnit || "",
      imageUrl: value.imageUrl || "",
      vat: value.vat || 6,
      active: value.active !== false,
      frozen: value.frozen ?? false,
      category: value.category || "",
      lastPriceUpdate: value.lastPriceUpdate || null,
      articleNumber: value.articleNumber || "",
      ean: value.ean || "",
      aliases: value.aliases || { en: "", fr: "", nl: "" },
    };
  });
}

// Haal alle articleen op via de master index
export async function getArticlesIndexed(hotelUidArg) {
  const hotelId = hotelUidArg || getSelectedHotelUid();
  const indexCol = collection(
    db,
    `hotels/${hotelId}/indexes/articleMasterIndex/articlesPerCategory`
  );
  const snapshot = await getDocs(indexCol);
  const result = [];
  snapshot.docs.forEach(docSnap => {
    const articleMap = docSnap.data().articleMap || {};
    Object.entries(articleMap).forEach(([id, data]) => {
      result.push({
        ...data,
        id,
        frozen: data.frozen ?? false,
        aliases: data.aliases || { en: "", fr: "", nl: "" },
      });
    });
  });
  return result;
}

// Ingrediënt bijwerken (met lastPriceUpdate)
export const updateArticle = async (hotelUid, id, updatedFields) => {
  if (!hotelUid || !id) return;
  const ingDoc = doc(db, `hotels/${hotelUid}/articles`, id);

  let extra = {};
  const currentSnap = await getDoc(ingDoc);
  let oldCategory = "";
  if (currentSnap.exists()) {
    const current = currentSnap.data();
    oldCategory = current.category || "";
    if (
      updatedFields.pricePerPurchaseUnit !== undefined &&
      updatedFields.pricePerPurchaseUnit !== null &&
      Number(current.pricePerPurchaseUnit) !== Number(updatedFields.pricePerPurchaseUnit)
    ) {
      extra.lastPriceUpdate = Date.now();
      extra._priceChanged = true;
    }
  }

  const { _priceChanged, ...updateData } = { ...updatedFields, ...extra };
  await updateDoc(ingDoc, updateData);

  if (_priceChanged) {
    const historyCol = collection(
      db,
      `hotels/${hotelUid}/articles/${id}/priceHistory`
    );
    await addDoc(historyCol, {
      price: Number(updatedFields.pricePerPurchaseUnit),
      date: extra.lastPriceUpdate,
    });
  }

  const newCategory =
    updatedFields.category !== undefined ? updatedFields.category : oldCategory;
  await rebuildArticleCategoryIndex(hotelUid, newCategory);
  if (oldCategory !== newCategory) {
    await rebuildArticleCategoryIndex(hotelUid, oldCategory);
  }
};

export async function getArticle(id) {
  const hotelId = getSelectedHotelUid();
  const ingDoc = doc(db, `hotels/${hotelId}/articles`, id);
  const snapshot = await getDoc(ingDoc);
  if (!snapshot.exists()) return null;
  return { id, ...snapshot.data() };
}

export async function deleteArticle(hotelUid, id) {
  if (!hotelUid || !id) return;
  const ingDoc = doc(db, `hotels/${hotelUid}/articles`, id);
  const snap = await getDoc(ingDoc);
  const category = snap.exists() ? snap.data().category || "" : "";
  await deleteDoc(ingDoc);
  await rebuildArticleCategoryIndex(hotelUid, category);
}

export async function rebuildArticleMasterIndex(hotelUid) {
  if (!hotelUid) throw new Error("hotelUid is verplicht!");

  const articlesCol = collection(db, `hotels/${hotelUid}/articles`);
  const snapshot = await getDocs(articlesCol);

  const perCategory = {};
  snapshot.docs.forEach(docSnap => {
    const data = docSnap.data();
    const aliases = data.aliases || { en: "", fr: "", nl: "" };
    const cat = data.category || "_uncategorized";
    if (!perCategory[cat]) perCategory[cat] = {};
    perCategory[cat][docSnap.id] = { ...data, id: docSnap.id, aliases };
  });

  const indexCol = collection(
    db,
    `hotels/${hotelUid}/indexes/articleMasterIndex/articlesPerCategory`
  );
  const existing = await getDocs(indexCol);

  const batch = writeBatch(db);
  existing.forEach(docSnap => batch.delete(docSnap.ref));

  Object.entries(perCategory).forEach(([catId, articleMap]) => {
    const ref = doc(indexCol, catId);
    batch.set(ref, { articleMap });
  });

  await batch.commit();

  console.log("Article masterindex rebuilt!");
}

export async function rebuildArticleCategoryIndex(hotelUid, categoryId) {
  if (!hotelUid) throw new Error("hotelUid is verplicht!");
  const cat = categoryId || "";

  const articlesCol = collection(db, `hotels/${hotelUid}/articles`);
  const q = query(articlesCol, where("category", "==", cat));
  const snapshot = await getDocs(q);

  const articleMap = {};
  snapshot.docs.forEach(docSnap => {
    const data = docSnap.data();
    articleMap[docSnap.id] = {
      ...data,
      id: docSnap.id,
      aliases: data.aliases || { en: "", fr: "", nl: "" },
    };
  });

  const indexCol = collection(
    db,
    `hotels/${hotelUid}/indexes/articleMasterIndex/articlesPerCategory`
  );
  const docId = cat || "_uncategorized";
  const ref = doc(indexCol, docId);

  if (Object.keys(articleMap).length > 0) {
    await setDoc(ref, { articleMap });
  } else {
    await deleteDoc(ref);
  }

  console.log(`Article category index rebuilt for ${docId}`);
}

// Voeg een prijsrecord toe aan de historiek
export async function addArticlePriceHistory(hotelUid, articleId, price, date = Date.now()) {
  if (!hotelUid || !articleId) return;
  const historyCol = collection(db, `hotels/${hotelUid}/articles/${articleId}/priceHistory`);
  await addDoc(historyCol, { price: Number(price), date });
}

// Haal prijshistoriek op voor een ingrediënt (nieuwste eerst)
export async function getArticlePriceHistory(hotelUid, articleId) {
  if (!hotelUid || !articleId) return [];
  const historyCol = collection(db, `hotels/${hotelUid}/articles/${articleId}/priceHistory`);
  const q = query(historyCol, orderBy("date", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
}

// Haal alle artikels op die nog niet aan een ingrediënt gekoppeld zijn
export async function getArticlesWithoutIngredient(hotelUidArg) {
  const [articles, ingredients] = await Promise.all([
    getArticles(hotelUidArg),
    getIngredients(hotelUidArg)
  ]);
  const linked = new Set();
  ingredients.forEach(ing => {
    const ids = Array.isArray(ing.articles) ? ing.articles : [];
    ids.forEach(id => linked.add(id));
  });
  return articles.filter(a => !linked.has(a.id));
}
