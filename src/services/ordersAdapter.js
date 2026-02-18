// Expected return: { [articleId]: totalOrderedUnitsBetween(start,end) }
// Retrieves aggregated received quantities for the given articleIds within the
// date range [start, end] based on the order's deliveryDate. Both the
// `deliveryDate` field on orders and the supplied `start`/`end` values should be
// `YYYY-MM-DD` strings. Queries the orders collection directly and sums the
// quantity received per article using each item's `received` field.
import { db, getDocs, query, where, collection } from "../firebaseConfig";
import { getSelectedHotelUid } from "../utils/hotelUtils";

export async function getOrderedUnitsByArticle({ articleIds = [], start, end }) {
  const ids = Array.from(new Set(articleIds.filter(Boolean)));
  const result = {};
  ids.forEach((id) => (result[id] = 0));

  const hotelUid = getSelectedHotelUid();
  if (!hotelUid || !ids.length || !start || !end) return result;

  const q = query(
    collection(db, `hotels/${hotelUid}/orders`),
    where("deliveryDate", ">=", start),
    where("deliveryDate", "<=", end)
  );
  const snap = await getDocs(q);
  const idSet = new Set(ids);

  snap.forEach((docSnap) => {
    const order = docSnap.data() || {};
    const items = Array.isArray(order.articles) ? order.articles : [];
    items.forEach((item) => {
      const aid = item.id || "";
      if (!idSet.has(aid)) return;
      const qty = Number(item.received) || 0;
      if (qty > 0) result[aid] += qty;
    });
  });

  return result;
}

