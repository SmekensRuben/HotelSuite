import { collection, db, getDocs } from "../firebaseConfig";

function normalizeDateValue(value) {
  if (!value) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
    return null;
  }

  if (value?.toDate instanceof Function) {
    return value.toDate().toISOString().slice(0, 10);
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  return null;
}

function sumRoomsSold(marketCodes) {
  if (!Array.isArray(marketCodes)) return 0;
  return marketCodes.reduce((total, item) => total + Number(item?.roomsSold || 0), 0);
}

function extractRowsFromSnapshotPayload(payload, fallbackStayDate = null) {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => extractRowsFromSnapshotPayload(entry, fallbackStayDate));
  }

  if (typeof payload !== "object") return [];

  const stayDate = normalizeDateValue(payload.stayDate || payload.recordId || fallbackStayDate);
  if (stayDate && Array.isArray(payload.marketCodes)) {
    return [{ id: stayDate, stayDate, roomsSold: sumRoomsSold(payload.marketCodes) }];
  }

  return Object.entries(payload).flatMap(([key, value]) => {
    const nestedStayDate = normalizeDateValue(key) || stayDate || fallbackStayDate;
    return extractRowsFromSnapshotPayload(value, nestedStayDate);
  });
}

async function getLatestReportDate(hotelUid) {
  const reportsRef = collection(db, "hotels", hotelUid, "reports");
  const reportsSnap = await getDocs(reportsRef);

  const reportDates = reportsSnap.docs
    .map((docSnap) => normalizeDateValue(docSnap.id) || normalizeDateValue(docSnap.data()?.snapshotDate))
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a));

  return reportDates[0] || null;
}

async function getReportRows(hotelUid, reportDate) {
  const recordsRef = collection(db, "hotels", hotelUid, "reports", reportDate, "records");
  const recordsSnap = await getDocs(recordsRef);

  const mergedRows = recordsSnap.docs.reduce((acc, docSnap) => {
    const stayDate = normalizeDateValue(docSnap.id) || normalizeDateValue(docSnap.data()?.stayDate);
    const extractedRows = extractRowsFromSnapshotPayload(docSnap.data(), stayDate);

    extractedRows.forEach((row) => {
      const current = acc.get(row.stayDate) || { ...row, roomsSold: 0 };
      current.roomsSold += row.roomsSold;
      acc.set(row.stayDate, current);
    });

    return acc;
  }, new Map());

  return Array.from(mergedRows.values()).sort((a, b) => a.stayDate.localeCompare(b.stayDate));
}

export async function getLatestPickUpRows(hotelUid) {
  if (!hotelUid) {
    return { snapshotDate: null, rows: [] };
  }

  const snapshotDate = await getLatestReportDate(hotelUid);
  if (!snapshotDate) {
    return { snapshotDate: null, rows: [] };
  }

  const rows = await getReportRows(hotelUid, snapshotDate);
  return { snapshotDate, rows };
}
