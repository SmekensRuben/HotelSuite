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

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCurrentMonthBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  return {
    today: formatLocalDate(now),
    monthStart: formatLocalDate(start),
    monthEnd: formatLocalDate(end),
  };
}

function sumNumericField(items, fieldName) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((total, item) => total + Number(item?.[fieldName] || 0), 0);
}

function extractMetrics(payload) {
  const roomsSold = Number.isFinite(Number(payload?.roomsSold))
    ? Number(payload.roomsSold)
    : sumNumericField(payload?.marketCodes, "roomsSold");

  const totalRevenue = Number.isFinite(Number(payload?.totalRevenue))
    ? Number(payload.totalRevenue)
    : sumNumericField(payload?.marketCodes, "totalRevenue");

  return { roomsSold, totalRevenue };
}

function extractRowsFromSnapshotPayload(payload, fallbackStayDate = null) {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => extractRowsFromSnapshotPayload(entry, fallbackStayDate));
  }

  if (typeof payload !== "object") return [];

  const stayDate = normalizeDateValue(payload.stayDate || payload.recordId || fallbackStayDate);
  if (stayDate && (Array.isArray(payload.marketCodes) || payload.roomsSold != null || payload.totalRevenue != null)) {
    const metrics = extractMetrics(payload);
    return [{ id: stayDate, stayDate, ...metrics }];
  }

  return Object.entries(payload).flatMap(([key, value]) => {
    const nestedStayDate = normalizeDateValue(key) || stayDate || fallbackStayDate;
    return extractRowsFromSnapshotPayload(value, nestedStayDate);
  });
}

async function getLatestSnapshotDate(hotelUid, reportType) {
  const snapshotDatesRef = collection(
    db,
    "hotels",
    hotelUid,
    "reports",
    reportType,
    "snapshotDates"
  );
  const snapshotDatesSnap = await getDocs(snapshotDatesRef);

  const snapshotDates = snapshotDatesSnap.docs
    .map((docSnap) => normalizeDateValue(docSnap.id) || normalizeDateValue(docSnap.data()?.snapshotDate))
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a));

  return snapshotDates[0] || null;
}

async function getStayDateRows(hotelUid, reportType, snapshotDate) {
  const stayDatesRef = collection(
    db,
    "hotels",
    hotelUid,
    "reports",
    reportType,
    "snapshotDates",
    snapshotDate,
    "stayDates"
  );
  const stayDatesSnap = await getDocs(stayDatesRef);

  const mergedRows = stayDatesSnap.docs.reduce((acc, docSnap) => {
    const stayDate = normalizeDateValue(docSnap.id) || normalizeDateValue(docSnap.data()?.stayDate);
    const extractedRows = extractRowsFromSnapshotPayload(docSnap.data(), stayDate);

    extractedRows.forEach((row) => {
      const current = acc.get(row.stayDate) || { ...row, roomsSold: 0, totalRevenue: 0 };
      current.roomsSold += row.roomsSold;
      current.totalRevenue += row.totalRevenue;
      acc.set(row.stayDate, current);
    });

    return acc;
  }, new Map());

  return Array.from(mergedRows.values()).sort((a, b) => a.stayDate.localeCompare(b.stayDate));
}

function filterRowsForCurrentMonth(rows, monthStart, monthEnd) {
  return rows.filter((row) => row.stayDate >= monthStart && row.stayDate <= monthEnd);
}

export async function getLatestPickUpRows(hotelUid) {
  if (!hotelUid) {
    return {
      forecastSnapshotDate: null,
      statisticsSnapshotDate: null,
      rows: [],
    };
  }

  const { today, monthStart, monthEnd } = getCurrentMonthBounds();
  const [forecastSnapshotDate, statisticsSnapshotDate] = await Promise.all([
    getLatestSnapshotDate(hotelUid, "reservationforecast"),
    getLatestSnapshotDate(hotelUid, "reservationstatistics"),
  ]);

  const [forecastRows, statisticsRows] = await Promise.all([
    forecastSnapshotDate ? getStayDateRows(hotelUid, "reservationforecast", forecastSnapshotDate) : [],
    statisticsSnapshotDate ? getStayDateRows(hotelUid, "reservationstatistics", statisticsSnapshotDate) : [],
  ]);

  const currentMonthForecastRows = filterRowsForCurrentMonth(forecastRows, monthStart, monthEnd)
    .filter((row) => row.stayDate >= today);
  const currentMonthStatisticsRows = filterRowsForCurrentMonth(statisticsRows, monthStart, monthEnd)
    .filter((row) => row.stayDate < today);

  const rows = [...currentMonthStatisticsRows, ...currentMonthForecastRows].sort((a, b) =>
    a.stayDate.localeCompare(b.stayDate)
  );

  return {
    forecastSnapshotDate,
    statisticsSnapshotDate,
    rows,
  };
}
