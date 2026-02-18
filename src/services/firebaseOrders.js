// src/services/firebaseOrders.js
import { db, collection, getDocs } from "../firebaseConfig";
import { collectionGroup, query } from "firebase/firestore";

/**
 * Haalt alle orders op voor het opgegeven hotelUid.
 * @returns {Promise<Array>} Lijst van orders [{id, ...orderdata, products: []}]
 */
export async function getOrders(hotelUid) {
  if (!hotelUid) return [];
  const q = query(collectionGroup(db, 'ordersList'));
  const snap = await getDocs(q);
  const result = [];
  snap.forEach(docSnap => {
    const parts = docSnap.ref.path.split('/');
    if (parts[1] === hotelUid) {
      const obj = docSnap.data();
      result.push({
        ...obj,
        id: docSnap.id,
        products: Array.isArray(obj.products)
          ? obj.products
          : Object.values(obj.products || {}),
      });
    }
  });
  return result;
}
