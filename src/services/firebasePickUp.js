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

export async function getLatestPickUpRows(hotelUid) {
  if (!hotelUid) {
    return { snapshotDate: null, rows: [] };
  }

  const snapshotsRef = collection(
    db,
    "hotels",
    hotelUid,
    "reports",
    "reservationforecast",
    "snapshotDate"
  );

  const snapshotsSnap = await getDocs(snapshotsRef);
  const snapshots = snapshotsSnap.docs
    .map((docSnap) => ({
      id: docSnap.id,
      snapshotDate: normalizeDateValue(docSnap.id) || normalizeDateValue(docSnap.data()?.snapshotDate),
      data: docSnap.data(),
    }))
    .filter((entry) => entry.snapshotDate);

  if (!snapshots.length) {
    return { snapshotDate: null, rows: [] };
  }

  const latestSnapshot = snapshots.sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate))[0];

  const mergedRows = extractRowsFromSnapshotPayload(latestSnapshot.data).reduce((acc, row) => {
    const current = acc.get(row.stayDate) || { ...row, roomsSold: 0 };
    current.roomsSold += row.roomsSold;
    acc.set(row.stayDate, current);
    return acc;
  }, new Map());

  const rows = Array.from(mergedRows.values()).sort((a, b) => a.stayDate.localeCompare(b.stayDate));

  return { snapshotDate: latestSnapshot.snapshotDate, rows };
}
