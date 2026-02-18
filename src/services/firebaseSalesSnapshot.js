import {
  db,
  collection,
  doc,
  getDocs,
  setDoc
} from "../firebaseConfig";
import { getProductsIndexed } from "./firebaseProducts";


// Build per-product sales index for a single day
// Format: { day, products: { [productId]: { qty, total, perOutlet: { [outlet]: qty } } } }
export async function updateDailyProductSales(hotelUid, day) {
  if (!hotelUid || !day) return;

  console.log("---- updateDailyProductSales ----");
  console.log("Hotel:", hotelUid, "Dag:", day);

  const receiptsCol = collection(db, `hotels/${hotelUid}/receipts/${day}/receiptList`);
  const receiptsSnap = await getDocs(receiptsCol);

  const products = await getProductsIndexed(hotelUid);
  const lsIdMap = {};
  (products || []).forEach(p => {
    if (p.lightspeedId !== undefined) {
      lsIdMap[String(p.lightspeedId).trim()] = p;
    }
  });

  const productTotals = {};

  receiptsSnap.forEach(docSnap => {
    const receipt = docSnap.data() || {};
    const outlet = receipt.outletName || receipt.floorName || "";

    (receipt.products || []).forEach(item => {
      const productId = String(item.productId).trim();
      const prod = lsIdMap[productId];
      if (!prod) {
        console.warn("No match for productId:", productId, "in product index");
        return;
      }

      const qty = Number(item.quantity) || 0;
      const priceInc = Number(prod.price) || 0;
      const vat = Number(prod.vat || 0);
      const priceEx = priceInc / (1 + vat / 100);
      const amount = qty * priceEx;

      const key = String(prod.lightspeedId).trim();
      if (!productTotals[key]) {
        productTotals[key] = { qty: 0, total: 0, perOutlet: {} };
      }
      productTotals[key].qty += qty;
      productTotals[key].total += amount;
      if (outlet) {
        productTotals[key].perOutlet[outlet] =
          (productTotals[key].perOutlet[outlet] || 0) + qty;
      }
    });
  });

  await setDoc(
    doc(db, `hotels/${hotelUid}/indexes/receiptMasterIndex/salesByDay/${day}`),
    { day, products: productTotals },
    { merge: true }
  );
}


// Haal geaccumuleerde productverkopen op uit salesByDay tussen twee datums
// Optioneel kan je filteren op een outlet. In dat geval wordt de hoeveelheid
// gefilterd op `perOutlet[outlet]` en wordt de omzet berekend op basis van de
// gemiddelde prijs in `data.total`.
export async function getProductSalesRange(
  hotelUid,
  dateFrom,
  dateTo,
  outlet = ""
) {
  if (!hotelUid || !dateFrom || !dateTo) return {};

  const salesCol = collection(
    db,
    `hotels/${hotelUid}/indexes/receiptMasterIndex/salesByDay`
  );
  const snap = await getDocs(salesCol);

  const totals = {};
  snap.forEach(docSnap => {
    const day = docSnap.id;
    if (day < dateFrom || day > dateTo) return;
    const products = docSnap.data().products || {};
    Object.entries(products).forEach(([pid, data]) => {
      let qty = data.qty || 0;
      let total = data.total || 0;

      if (outlet) {
        const perOutletQty = (data.perOutlet || {})[outlet] || 0;
        const unitPrice = data.qty ? data.total / data.qty : 0;
        qty = perOutletQty;
        total = unitPrice * perOutletQty;
      }

      if (qty === 0) return;

      if (!totals[pid]) totals[pid] = { qty: 0, total: 0 };
      totals[pid].qty += qty;
      totals[pid].total += total;
    });
  });

  return totals;
}
