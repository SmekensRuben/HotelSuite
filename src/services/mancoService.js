import { db, getDocs, collection, query } from "../firebaseConfig";

function isSignificantShortage(product) {
  const shortage = Number(product.shortage) || 0;
  if (shortage <= 0) return false;
  if (product.isWeighed) {
    const ordered = Number(product.quantity) || 0;
    if (ordered <= 0) return false;
    return shortage / ordered > 0.25;
  }
  return true;
}
export { isSignificantShortage as _isSignificantShortage };

/**
 * Haalt alle manco's uit ontvangen orders op.
 * @param {string} hotelUid
 * @returns {Promise<Array>} Lijst van manco's: [{id, date, supplier, product, brand, quantity, note, orderId}]
 */
export async function getAllMancos(hotelUid) {
  if (!hotelUid) return [];
  const q = query(collection(db, `hotels/${hotelUid}/orders`));
  const snap = await getDocs(q);

  let mancos = [];
  snap.forEach(docSnap => {
    const order = docSnap.data();
    const orderId = docSnap.id;
    if (order.status === "received" && Array.isArray(order.articles)) {
      order.articles.forEach(prod => {
        if (!isSignificantShortage(prod)) return;
        mancos.push({
          id: `${orderId}_${prod.ingredientId || prod.name}`,
          orderId,
          date: order.deliveryDate || order.orderDate || "",
          supplier: order.supplier || prod.supplier || "",
          artikelnummer: prod.artikelnummer || prod.articleNumber || "",
          product: prod.name || "",
          brand: prod.brand || "",
          quantity: prod.shortage,
          unitsPerPurchaseUnit: prod.unitsPerPurchaseUnit || "",
          stockUnit: prod.stockUnit || "",
          pricePerPurchaseUnit: prod.pricePerPurchaseUnit || ""
        });
      });
    }
  });
  // Nieuwste eerst:
  mancos.sort((a, b) => (b.date < a.date ? 1 : -1));
  return mancos;
}

/**
 * Berekent manco-statistiek per supplier.
 * Geeft een lijst: [{supplier, totalOrdered, totalShortage, percent}]
 */
export async function getSupplyStatsPerSupplier(hotelUid) {
  if (!hotelUid) return [];
  const q = query(collection(db, `hotels/${hotelUid}/orders`));
  const snap = await getDocs(q);

  const supplierStats = {};

  snap.forEach(docSnap => {
    const order = docSnap.data();
    if (order.status === "received" && Array.isArray(order.articles)) {
      const supplier = order.supplier || "Onbekend";
      order.articles.forEach(prod => {
        const ordered = Number(prod.quantity) || 0;
        if (!supplierStats[supplier]) {
          supplierStats[supplier] = { ordered: 0, supplied: 0 };
        }
        if (ordered > 0) {
          supplierStats[supplier].ordered += 1;
          if (!isSignificantShortage(prod)) {
            supplierStats[supplier].supplied += 1;
          }
        }
      });
    }
  });

  return Object.entries(supplierStats).map(([supplier, { ordered, supplied }]) => {
    const percentSupplied = ordered > 0 ? (supplied / ordered) * 100 : 0;
    return {
      supplier,
      totalOrdered: ordered,
      totalSupplied: supplied,
      percentSupplied
    };
  });
}
