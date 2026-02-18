import {
  db,
  collection,
  doc,
  getDocs,
  addDoc,
  setDoc,
  deleteDoc,
} from "../firebaseConfig";
import { getSelectedHotelUid } from "../utils/hotelUtils";

export async function getSalesPromoTickets(hotelUidArg) {
  const hotelUid = hotelUidArg || getSelectedHotelUid();
  if (!hotelUid) return [];
  const ticketsCol = collection(db, `hotels/${hotelUid}/salesPromoTickets`);
  const snapshot = await getDocs(ticketsCol);
  return snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
}

export async function addSalesPromoTicket(hotelUidArg, ticket) {
  const hotelUid = hotelUidArg || getSelectedHotelUid();
  if (!hotelUid) return null;
  const ticketsCol = collection(db, `hotels/${hotelUid}/salesPromoTickets`);
  const docRef = await addDoc(ticketsCol, ticket);
  return docRef.id;
}

export async function updateSalesPromoTicket(hotelUidArg, id, ticket) {
  const hotelUid = hotelUidArg || getSelectedHotelUid();
  if (!hotelUid || !id) return;
  const ticketDoc = doc(db, `hotels/${hotelUid}/salesPromoTickets`, id);
  await setDoc(ticketDoc, ticket, { merge: true });
}

export async function deleteSalesPromoTicket(hotelUidArg, id) {
  const hotelUid = hotelUidArg || getSelectedHotelUid();
  if (!hotelUid || !id) return;
  const ticketDoc = doc(db, `hotels/${hotelUid}/salesPromoTickets`, id);
  await deleteDoc(ticketDoc);
}

export async function getLightspeedNegativeTicketTotal(
  hotelUidArg,
  day
) {
  const hotelUid = hotelUidArg || getSelectedHotelUid();
  if (!hotelUid || !day) return { total: 0, tickets: [] };

  const receiptsCol = collection(db, `hotels/${hotelUid}/receipts/${day}/receiptList`);
  const snapshot = await getDocs(receiptsCol);

  let total = 0;
  const tickets = [];

  const toNumber = value => {
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? num : 0;
  };

  const resolveQuantity = value => {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    if (typeof value === "number") {
      return value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  };

  const buildReceiptDetails = (receiptData, fallbackId, products = []) => ({
    creationDate:
      receiptData?.creationDate || receiptData?.createdAt || receiptData?.creation_datetime || null,
    finalizedDate:
      receiptData?.finalizedDate || receiptData?.finalizedAt || receiptData?.closedAt || null,
    outletName:
      receiptData?.outletName || receiptData?.outlet || receiptData?.outletLabel || receiptData?.registerName || null,
    receiptId: receiptData?.receiptId || receiptData?.receiptNumber || fallbackId || null,
    username:
      receiptData?.username ||
      receiptData?.userName ||
      receiptData?.cashier ||
      receiptData?.cashierName ||
      receiptData?.employeeName ||
      null,
    products,
  });

  snapshot.forEach(docSnap => {
    const data = docSnap.data() || {};
    const liteserverId = `${data.liteserverId || ""}`.trim();
    const fallbackTicketNumber = `${
      data.receiptId || data.receiptNumber || docSnap.id || ""
    }`.trim();
    const ticketNumber = liteserverId || fallbackTicketNumber;

    if (Array.isArray(data.products) && data.products.length > 0) {
      let receiptTotal = 0;

      const receiptProducts = data.products.map(product => {
        const quantity = resolveQuantity(
          product?.quantity ??
            product?.qty ??
            product?.quantityOrdered ??
            product?.quantitySold ??
            null
        );
        const rawTotal =
          product?.totalTaxInclusivePrice ??
          product?.totalTaxIncl ??
          product?.totalPrice ??
          product?.total ??
          product?.priceTaxIncluded ??
          product?.priceTaxInclusive ??
          null;
        const numericTotal =
          typeof rawTotal === "number" ? rawTotal : Number(rawTotal);

        if (Number.isFinite(numericTotal) && numericTotal < 0) {
          receiptTotal += numericTotal;
        }

        return {
          name: product?.name || product?.productName || product?.description || "",
          quantity,
          totalTaxInclusivePrice: Number.isFinite(numericTotal) ? numericTotal : null,
        };
      });

      if (receiptTotal < 0) {
        total += receiptTotal;
        tickets.push({
          ticketNumber,
          liteserverId: liteserverId || null,
          amount: receiptTotal,
          receiptDocId: docSnap.id,
          receiptDetails: buildReceiptDetails(data, fallbackTicketNumber, receiptProducts),
        });
      }
      return;
    }

    const receiptTotal = toNumber(data.totalTaxInclusivePrice);
    if (receiptTotal < 0) {
      total += receiptTotal;
      tickets.push({
        ticketNumber,
        liteserverId: liteserverId || null,
        amount: receiptTotal,
        receiptDocId: docSnap.id,
        receiptDetails: buildReceiptDetails(data, fallbackTicketNumber, []),
      });
    }
  });

  return { total, tickets };
}

const normalizeIdentifier = value => `${value || ""}`.trim();

const matchesTicketIdentifiers = (candidate, identifiers) => {
  if (!candidate || !identifiers) {
    return false;
  }

  const candidateReceiptDocId = normalizeIdentifier(candidate.receiptDocId);
  const candidateLiteserverId = normalizeIdentifier(candidate.liteserverId);
  const candidateTicketNumber = normalizeIdentifier(candidate.ticketNumber);

  const identifierReceiptDocId = normalizeIdentifier(identifiers.receiptDocId);
  const identifierLiteserverId = normalizeIdentifier(identifiers.liteserverId);
  const identifierTicketNumber = normalizeIdentifier(identifiers.ticketNumber);

  if (identifierReceiptDocId && candidateReceiptDocId === identifierReceiptDocId) {
    return true;
  }

  if (identifierLiteserverId && candidateLiteserverId === identifierLiteserverId) {
    return true;
  }

  if (identifierTicketNumber && candidateTicketNumber === identifierTicketNumber) {
    return true;
  }

  return false;
};

export async function getLightspeedReceiptDetails(hotelUidArg, day, identifiers = {}) {
  if (!day) {
    return null;
  }

  const { tickets } = await getLightspeedNegativeTicketTotal(hotelUidArg, day);
  if (!Array.isArray(tickets)) {
    return null;
  }

  const matchingTicket = tickets.find(ticket => matchesTicketIdentifiers(ticket, identifiers));
  return matchingTicket?.receiptDetails || null;
}

export async function getSalesPromoReconciliation(hotelUidArg) {
  const hotelUid = hotelUidArg || getSelectedHotelUid();
  if (!hotelUid) return [];

  const reconciliationCol = collection(
    db,
    `hotels/${hotelUid}/salesPromoReconciliation`
  );
  const snapshot = await getDocs(reconciliationCol);

  return snapshot.docs.map(docSnap => {
    const data = docSnap.data() || {};
    return {
      day: docSnap.id,
      lightspeedAmount:
        typeof data.lightspeedAmount === "number" ? data.lightspeedAmount : undefined,
      lightspeedTickets: Array.isArray(data.lightspeedTickets)
        ? data.lightspeedTickets
        : [],
      updatedAt: data.updatedAt || null,
    };
  });
}

export async function setSalesPromoReconciliation(hotelUidArg, day, data) {
  const hotelUid = hotelUidArg || getSelectedHotelUid();
  if (!hotelUid || !day) return;

  const docRef = doc(db, `hotels/${hotelUid}/salesPromoReconciliation/${day}`);
  const { lightspeedAmount = 0, lightspeedTickets = [] } = data || {};
  await setDoc(
    docRef,
    {
      lightspeedAmount,
      lightspeedTickets,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
}

