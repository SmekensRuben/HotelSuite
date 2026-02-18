// src/services/firebaseReceiptItemSummary.js
import {
  db,
  collection,
  doc,
  getDocs,
  setDoc
} from "../firebaseConfig";
import { collectionGroup, query, where } from 'firebase/firestore';
import { getProductsIndexed } from "./firebaseProducts";

// Build aggregated receipt item summary for a single day
// Result document format:
// {
//   day,
//   items: {
//     [productId]: {
//       productId,
//       qty,
//       category,
//       taxPercentage,
//       totalTaxInclusivePrice,
//       totalTaxExclusivePrice,
//       taxExclusivePrice,
//       name,
//       description,
//       productName,
//       perOutlet: { [outletName]: qty }
//     }
//   }
// }
export async function updateReceiptItemSummary(hotelUid, day) {
  if (!hotelUid || !day) return;

  const receiptsCol = collection(db, `hotels/${hotelUid}/receipts/${day}/receiptList`);
  const [receiptsSnap, products] = await Promise.all([
    getDocs(receiptsCol),
    getProductsIndexed(hotelUid)
  ]);

  const lsIdToCategory = {};
  (products || []).forEach(p => {
    if (p.lightspeedId !== undefined) {
      lsIdToCategory[String(p.lightspeedId).trim()] = p.category || "";
    }
  });

  const summary = {};
  receiptsSnap.forEach(docSnap => {
    const receipt = docSnap.data() || {};
    const outlet = receipt.outletName || receipt.floorName || "";
    (receipt.products || []).forEach(item => {
      const pid = String(item.productId || "").trim();
      if (!pid) return;
      const qty = Number(
        item.netQuantity !== undefined ? item.netQuantity : item.quantity
      ) || 0;
      const taxPct = Number(item.taxPercentage) || 0;
      const priceInc = Number(item.taxInclusivePrice) || 0;
      const total = Number(item.totalTaxInclusivePrice) || 0;
      const cat = lsIdToCategory[pid] || "";
      const factor = 1 + taxPct / 100;
      const priceExc = factor ? priceInc / factor : priceInc;
      const totalExc = factor ? total / factor : total;
      const itemName = typeof item.name === "string" ? item.name.trim() : "";
      const itemDescription = typeof item.description === "string"
        ? item.description.trim()
        : "";
      const itemProductName = typeof item.productName === "string"
        ? item.productName.trim()
        : "";
      const preferredName = itemName || itemDescription || itemProductName;

      if (!summary[pid]) {
        summary[pid] = {
          productId: pid,
          qty: 0,
          category: cat,
          taxPercentage: taxPct,
          totalTaxInclusivePrice: 0,
          totalTaxExclusivePrice: 0,
          name: preferredName,
          description: itemDescription,
          productName: itemProductName,
          perOutlet: {}
        };
      }
      summary[pid].qty += qty;
      summary[pid].totalTaxInclusivePrice += total;
      summary[pid].totalTaxExclusivePrice += totalExc;
      if (!summary[pid].category && cat) summary[pid].category = cat;
      if (!summary[pid].taxPercentage && taxPct) summary[pid].taxPercentage = taxPct;
      if (!summary[pid].name && preferredName) summary[pid].name = preferredName;
      if (!summary[pid].description && itemDescription) {
        summary[pid].description = itemDescription;
      }
      if (!summary[pid].productName && itemProductName) {
        summary[pid].productName = itemProductName;
      }
      if (outlet) {
        summary[pid].perOutlet[outlet] =
          (summary[pid].perOutlet[outlet] || 0) + qty;
      }
    });
  });

  Object.values(summary).forEach(item => {
    item.taxExclusivePrice = item.qty
      ? item.totalTaxExclusivePrice / item.qty
      : 0;
  });

  await setDoc(
    doc(db, `hotels/${hotelUid}/receipts/${day}/receiptItemSummary/summary`),
    { day, items: summary },
    { merge: true }
  );
}

// Fetch receipt item summary documents for a date range (inclusive)
export async function getReceiptItemSummaries(hotelUid, startDate = "", endDate = "") {
  if (!hotelUid) return [];

  let q = collectionGroup(db, "receiptItemSummary");
  const constraints = [];
  if (startDate) constraints.push(where("day", ">=", startDate));
  if (endDate) constraints.push(where("day", "<=", endDate));
  if (constraints.length > 0) {
    q = query(q, ...constraints);
  }

  const snap = await getDocs(q);
  const results = [];
  snap.forEach(docSnap => {
    const pathParts = docSnap.ref.path.split("/");
    if (pathParts[1] !== hotelUid) return;
    results.push(docSnap.data());
  });

  return results;
}

