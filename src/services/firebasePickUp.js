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

function getCurrentMonthKey() {
  return formatLocalDate(new Date()).slice(0, 7);
}

function sumNumericField(items, fieldName) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((total, item) => total + Number(item?.[fieldName] || 0), 0);
}

function sumCalculatedRevenue(marketCodes) {
  if (!Array.isArray(marketCodes)) return 0;
  return marketCodes.reduce(
    (total, item) => total + Number(item?.roomsSold || 0) * Number(item?.avgRoomRevenue || 0),
    0
  );
}

function extractMetrics(payload) {
  const roomsSold = Number.isFinite(Number(payload?.roomsSold))
    ? Number(payload.roomsSold)
    : sumNumericField(payload?.marketCodes, "roomsSold");

  const totalRevenue = Number.isFinite(Number(payload?.totalRevenue))
    ? Number(payload.totalRevenue)
    : sumNumericField(payload?.marketCodes, "totalRevenue");

  const totalCalculatedRevenue = sumCalculatedRevenue(payload?.marketCodes);

  return { roomsSold, totalRevenue, totalCalculatedRevenue };
}

function extractRowsFromSnapshotPayload(payload, fallbackStayDate = null) {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => extractRowsFromSnapshotPayload(entry, fallbackStayDate));
  }

  if (typeof payload !== "object") return [];

  const stayDate = normalizeDateValue(payload.stayDate || payload.recordId || fallbackStayDate);
  if (
    stayDate &&
    (Array.isArray(payload.marketCodes) || payload.roomsSold != null || payload.totalRevenue != null)
  ) {
    const metrics = extractMetrics(payload);
    return [{ id: stayDate, stayDate, ...metrics }];
  }

  return Object.entries(payload).flatMap(([key, value]) => {
    const nestedStayDate = normalizeDateValue(key) || stayDate || fallbackStayDate;
    return extractRowsFromSnapshotPayload(value, nestedStayDate);
  });
}

async function getSnapshotDates(hotelUid, reportType) {
  const snapshotDatesRef = collection(
    db,
    "hotels",
    hotelUid,
    "reports",
    reportType,
    "snapshotDates"
  );
  const snapshotDatesSnap = await getDocs(snapshotDatesRef);

  return snapshotDatesSnap.docs
    .map((docSnap) => normalizeDateValue(docSnap.id) || normalizeDateValue(docSnap.data()?.snapshotDate))
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a));
}

async function getStayDateRows(hotelUid, reportType, snapshotDate) {
  if (!snapshotDate) return [];

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
      const current = acc.get(row.stayDate) || {
        ...row,
        roomsSold: 0,
        totalRevenue: 0,
        totalCalculatedRevenue: 0,
      };
      current.roomsSold += row.roomsSold;
      current.totalRevenue += row.totalRevenue;
      current.totalCalculatedRevenue += row.totalCalculatedRevenue;
      acc.set(row.stayDate, current);
    });

    return acc;
  }, new Map());

  return Array.from(mergedRows.values()).sort((a, b) => a.stayDate.localeCompare(b.stayDate));
}

function filterRowsForMonth(rows, monthKey) {
  return rows.filter((row) => row.stayDate.startsWith(monthKey));
}

function buildDeltaRows(currentRows, previousRows) {
  const previousRowsByDate = new Map(previousRows.map((row) => [row.stayDate, row]));

  return currentRows.map((row) => {
    const previousRow = previousRowsByDate.get(row.stayDate);
    return {
      ...row,
      roomsSoldDelta: row.roomsSold - Number(previousRow?.roomsSold || 0),
    };
  });
}

function buildTotals(rows) {
  return rows.reduce(
    (totals, row) => ({
      totalRoomsSold: totals.totalRoomsSold + Number(row.roomsSold || 0),
      totalRevenue: totals.totalRevenue + Number(row.totalRevenue || 0),
      totalCalculatedRevenue:
        totals.totalCalculatedRevenue + Number(row.totalCalculatedRevenue || 0),
    }),
    {
      totalRoomsSold: 0,
      totalRevenue: 0,
      totalCalculatedRevenue: 0,
    }
  );
}

export async function getLatestPickUpRows(hotelUid, monthKey = getCurrentMonthKey()) {
  if (!hotelUid) {
    return {
      monthKey,
      forecastSnapshotDate: null,
      previousForecastSnapshotDate: null,
      statisticsSnapshotDate: null,
      previousStatisticsSnapshotDate: null,
      totals: buildTotals([]),
      rows: [],
    };
  }

  const today = formatLocalDate(new Date());
  const [forecastSnapshotDates, statisticsSnapshotDates] = await Promise.all([
    getSnapshotDates(hotelUid, "reservationforecast"),
    getSnapshotDates(hotelUid, "reservationstatistics"),
  ]);

  const [forecastSnapshotDate, previousForecastSnapshotDate] = forecastSnapshotDates;
  const [statisticsSnapshotDate, previousStatisticsSnapshotDate] = statisticsSnapshotDates;

  const [forecastRows, previousForecastRows, statisticsRows, previousStatisticsRows] = await Promise.all([
    getStayDateRows(hotelUid, "reservationforecast", forecastSnapshotDate),
    getStayDateRows(hotelUid, "reservationforecast", previousForecastSnapshotDate),
    getStayDateRows(hotelUid, "reservationstatistics", statisticsSnapshotDate),
    getStayDateRows(hotelUid, "reservationstatistics", previousStatisticsSnapshotDate),
  ]);

  const currentMonthForecastRows = buildDeltaRows(
    filterRowsForMonth(forecastRows, monthKey).filter((row) => row.stayDate >= today),
    filterRowsForMonth(previousForecastRows, monthKey)
  );
  const currentMonthStatisticsRows = buildDeltaRows(
    filterRowsForMonth(statisticsRows, monthKey).filter((row) => row.stayDate < today),
    filterRowsForMonth(previousStatisticsRows, monthKey)
  );

  const rows = [...currentMonthStatisticsRows, ...currentMonthForecastRows].sort((a, b) =>
    a.stayDate.localeCompare(b.stayDate)
  );

  return {
    monthKey,
    forecastSnapshotDate,
    previousForecastSnapshotDate,
    statisticsSnapshotDate,
    previousStatisticsSnapshotDate,
    totals: buildTotals(rows),
    rows,
  };
}
