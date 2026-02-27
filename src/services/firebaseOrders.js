import {
  db,
  addDoc,
  collection,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
} from "../firebaseConfig";

export async function getShoppingCarts(hotelUid) {
  if (!hotelUid) return [];

  const cartsCol = collection(db, `hotels/${hotelUid}/shoppingCarts`);
  const cartsQuery = query(cartsCol, orderBy("createdAt", "desc"));
  const snap = await getDocs(cartsQuery);

  return snap.docs.map((docSnap) => {
    const data = docSnap.data() || {};
    return {
      id: docSnap.id,
      ...data,
      items: Array.isArray(data.items) ? data.items : [],
    };
  });
}

export async function createShoppingCart(hotelUid, { createdBy, items = [] }) {
  if (!hotelUid) throw new Error("hotelUid is verplicht");

  const cartsCol = collection(db, `hotels/${hotelUid}/shoppingCarts`);
  const sanitizedItems = items
    .filter((item) => Number(item.qtyPurchaseUnits) > 0)
    .map((item) => ({
      supplierId: String(item.supplierId || "").trim(),
      supplierProductId: String(item.supplierProductId || "").trim(),
      variantId: String(item.variantId || "").trim(),
      qtyPurchaseUnits: Number(item.qtyPurchaseUnits) || 0,
      supplierSku: String(item.supplierSku || "").trim(),
      supplierProductName: String(item.supplierProductName || "").trim(),
      purchaseUnit: String(item.purchaseUnit || "").trim(),
      pricingModel: String(item.pricingModel || "").trim(),
      pricePerPurchaseUnit: Number(item.pricePerPurchaseUnit) || 0,
      currency: String(item.currency || "").trim() || "EUR",
      baseUnit: String(item.baseUnit || "").trim(),
      baseUnitsPerPurchaseUnit: Number(item.baseUnitsPerPurchaseUnit) || 0,
      updatedAt: serverTimestamp(),
    }))
    .filter((item) => item.supplierId && item.supplierProductId);

  if (sanitizedItems.length === 0) {
    throw new Error("Voeg minstens één supplier product toe");
  }

  const payload = {
    createdBy: createdBy || "unknown",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    items: sanitizedItems,
  };

  const docRef = await addDoc(cartsCol, payload);
  return docRef.id;
}
