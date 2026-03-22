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

function getMarketCodeLabel(item) {
  const label =
    item?.marketCode ||
    item?.code ||
    item?.marketSegment ||
    item?.segmentCode ||
    item?.name ||
    item?.id ||
    item?.label;

  if (label == null) return null;
  return String(label).trim() || null;
}

function normalizeMarketCodeEntries(marketCodes) {
  if (!Array.isArray(marketCodes)) return [];

  return marketCodes.reduce((entries, item) => {
    const marketCode = getMarketCodeLabel(item);
    if (!marketCode) return entries;

    entries.push({
      marketCode,
      roomsSold: Number(item?.roomsSold || 0),
      totalRevenue: Number(item?.totalRevenue || 0),
      totalCalculatedRevenue: Number(item?.roomsSold || 0) * Number(item?.avgRoomRevenue || 0),
    });

    return entries;
  }, []);
}

function extractMetrics(payload) {
  const marketCodeEntries = normalizeMarketCodeEntries(payload?.marketCodes);
  const roomsSold = Number.isFinite(Number(payload?.roomsSold))
    ? Number(payload.roomsSold)
    : sumNumericField(marketCodeEntries, "roomsSold");

  const totalRevenue = Number.isFinite(Number(payload?.totalRevenue))
    ? Number(payload.totalRevenue)
    : sumNumericField(marketCodeEntries, "totalRevenue");

  const totalCalculatedRevenue = marketCodeEntries.length
    ? sumNumericField(marketCodeEntries, "totalCalculatedRevenue")
    : sumCalculatedRevenue(payload?.marketCodes);

  return { roomsSold, totalRevenue, totalCalculatedRevenue, marketCodeEntries };
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

function mergeMarketCodeEntries(currentEntries = [], nextEntries = []) {
  const mergedEntries = [...currentEntries].reduce((acc, entry) => {
    acc.set(entry.marketCode, { ...entry });
    return acc;
  }, new Map());

  nextEntries.forEach((entry) => {
    const currentEntry = mergedEntries.get(entry.marketCode) || {
      marketCode: entry.marketCode,
      roomsSold: 0,
      totalRevenue: 0,
      totalCalculatedRevenue: 0,
    };

    currentEntry.roomsSold += Number(entry.roomsSold || 0);
    currentEntry.totalRevenue += Number(entry.totalRevenue || 0);
    currentEntry.totalCalculatedRevenue += Number(entry.totalCalculatedRevenue || 0);
    mergedEntries.set(entry.marketCode, currentEntry);
  });

  return Array.from(mergedEntries.values()).sort((a, b) => a.marketCode.localeCompare(b.marketCode));
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
        marketCodeEntries: [],
      };
      current.roomsSold += row.roomsSold;
      current.totalRevenue += row.totalRevenue;
      current.totalCalculatedRevenue += row.totalCalculatedRevenue;
      current.marketCodeEntries = mergeMarketCodeEntries(current.marketCodeEntries, row.marketCodeEntries);
      acc.set(row.stayDate, current);
    });

    return acc;
  }, new Map());

  return Array.from(mergedRows.values()).sort((a, b) => a.stayDate.localeCompare(b.stayDate));
}

function filterRowsForMonth(rows, monthKey) {
  return rows.filter((row) => row.stayDate.startsWith(monthKey));
}

function getAvgAdr(totalCalculatedRevenue, roomsSold) {
  if (!roomsSold) return 0;
  return totalCalculatedRevenue / roomsSold;
}

function filterRowByMarketCodes(row, selectedMarketCodesSet) {
  if (!row) return null;
  if (!selectedMarketCodesSet || selectedMarketCodesSet.size === 0) return row;

  const marketCodeEntries = (row.marketCodeEntries || []).filter((entry) =>
    selectedMarketCodesSet.has(entry.marketCode)
  );

  return {
    ...row,
    roomsSold: sumNumericField(marketCodeEntries, "roomsSold"),
    totalRevenue: sumNumericField(marketCodeEntries, "totalRevenue"),
    totalCalculatedRevenue: sumNumericField(marketCodeEntries, "totalCalculatedRevenue"),
    marketCodeEntries,
  };
}

function buildRowsWithPrevious(currentRows, previousRows, fallbackPreviousRows = [], selectedMarketCodes = []) {
  const selectedMarketCodesSet = new Set(selectedMarketCodes);
  const previousRowsByDate = new Map(previousRows.map((row) => [row.stayDate, row]));
  const fallbackRowsByDate = new Map(fallbackPreviousRows.map((row) => [row.stayDate, row]));

  return currentRows.map((sourceRow) => {
    const row = filterRowByMarketCodes(sourceRow, selectedMarketCodesSet);
    const previousRow = filterRowByMarketCodes(
      previousRowsByDate.get(sourceRow.stayDate) || fallbackRowsByDate.get(sourceRow.stayDate),
      selectedMarketCodesSet
    );

    const previousRoomsSold = Number(previousRow?.roomsSold || 0);
    const previousTotalCalculatedRevenue = Number(previousRow?.totalCalculatedRevenue || 0);
    const avgAdr = getAvgAdr(row.totalCalculatedRevenue, row.roomsSold);
    const previousAvgAdr = getAvgAdr(previousTotalCalculatedRevenue, previousRoomsSold);

    return {
      ...row,
      avgAdr,
      previousRoomsSold,
      previousTotalCalculatedRevenue,
      previousAvgAdr,
      roomsSoldDelta: row.roomsSold - previousRoomsSold,
      avgAdrDelta: avgAdr - previousAvgAdr,
    };
  });
}

function buildTotals(rows) {
  return rows.reduce(
    (totals, row) => ({
      totalRoomsSold: totals.totalRoomsSold + Number(row.roomsSold || 0),
      totalCalculatedRevenue:
        totals.totalCalculatedRevenue + Number(row.totalCalculatedRevenue || 0),
      previousTotalRoomsSold: totals.previousTotalRoomsSold + Number(row.previousRoomsSold || 0),
      previousTotalCalculatedRevenue:
        totals.previousTotalCalculatedRevenue + Number(row.previousTotalCalculatedRevenue || 0),
    }),
    {
      totalRoomsSold: 0,
      totalCalculatedRevenue: 0,
      previousTotalRoomsSold: 0,
      previousTotalCalculatedRevenue: 0,
    }
  );
}

function collectMarketCodes(...rowGroups) {
  return Array.from(
    rowGroups.reduce((codes, rows) => {
      rows.forEach((row) => {
        (row.marketCodeEntries || []).forEach((entry) => {
          if (entry.marketCode) codes.add(entry.marketCode);
        });
      });
      return codes;
    }, new Set())
  ).sort((a, b) => a.localeCompare(b));
}

function collectAvailableSnapshotDates(forecastSnapshotDates, statisticsSnapshotDates) {
  const statisticsSet = new Set(statisticsSnapshotDates);
  const overlappingDates = forecastSnapshotDates.filter((snapshotDate) => statisticsSet.has(snapshotDate));

  if (overlappingDates.length > 0) return overlappingDates;

  return Array.from(new Set([...forecastSnapshotDates, ...statisticsSnapshotDates])).sort((a, b) =>
    b.localeCompare(a)
  );
}

function resolveSnapshotDate(snapshotDates, selectedSnapshotDate) {
  if (!selectedSnapshotDate) return snapshotDates[0] || null;
  return snapshotDates.find((snapshotDate) => snapshotDate === selectedSnapshotDate) || snapshotDates[0] || null;
}

export async function getLatestPickUpRows(
  hotelUid,
  monthKey = getCurrentMonthKey(),
  selectedMarketCodes = [],
  pickupComparisonDays = 1,
  selectedSnapshotDate = null
) {
  if (!hotelUid) {
    return {
      monthKey,
      forecastSnapshotDate: null,
      previousForecastSnapshotDate: null,
      statisticsSnapshotDate: null,
      previousStatisticsSnapshotDate: null,
      availableMarketCodes: [],
      availableSnapshotDates: [],
      selectedSnapshotDate: null,
      pickupComparisonDays: Math.max(1, Number(pickupComparisonDays) || 1),
      totals: buildTotals([]),
      rows: [],
    };
  }

  const today = formatLocalDate(new Date());
  const [forecastSnapshotDates, statisticsSnapshotDates] = await Promise.all([
    getSnapshotDates(hotelUid, "reservationforecast"),
    getSnapshotDates(hotelUid, "reservationstatistics"),
  ]);

  const normalizedPickupComparisonDays = Math.max(1, Math.floor(Number(pickupComparisonDays) || 1));
  const availableSnapshotDates = collectAvailableSnapshotDates(
    forecastSnapshotDates,
    statisticsSnapshotDates
  );
  const resolvedSnapshotDate = resolveSnapshotDate(availableSnapshotDates, selectedSnapshotDate);
  const forecastSnapshotDate = resolveSnapshotDate(forecastSnapshotDates, resolvedSnapshotDate);
  const statisticsSnapshotDate = resolveSnapshotDate(statisticsSnapshotDates, resolvedSnapshotDate);
  const forecastSnapshotIndex = forecastSnapshotDates.findIndex((snapshotDate) => snapshotDate === forecastSnapshotDate);
  const statisticsSnapshotIndex = statisticsSnapshotDates.findIndex((snapshotDate) => snapshotDate === statisticsSnapshotDate);
  const previousForecastSnapshotDate =
    forecastSnapshotIndex >= 0
      ? forecastSnapshotDates[forecastSnapshotIndex + normalizedPickupComparisonDays] || null
      : null;
  const previousStatisticsSnapshotDate =
    statisticsSnapshotIndex >= 0
      ? statisticsSnapshotDates[statisticsSnapshotIndex + normalizedPickupComparisonDays] || null
      : null;

  const [forecastRows, previousForecastRows, statisticsRows, previousStatisticsRows] = await Promise.all([
    getStayDateRows(hotelUid, "reservationforecast", forecastSnapshotDate),
    getStayDateRows(hotelUid, "reservationforecast", previousForecastSnapshotDate),
    getStayDateRows(hotelUid, "reservationstatistics", statisticsSnapshotDate),
    getStayDateRows(hotelUid, "reservationstatistics", previousStatisticsSnapshotDate),
  ]);

  const monthForecastRows = filterRowsForMonth(forecastRows, monthKey);
  const monthPreviousForecastRows = filterRowsForMonth(previousForecastRows, monthKey);
  const monthStatisticsRows = filterRowsForMonth(statisticsRows, monthKey);
  const monthPreviousStatisticsRows = filterRowsForMonth(previousStatisticsRows, monthKey);

  const currentMonthForecastRows = buildRowsWithPrevious(
    monthForecastRows.filter((row) => row.stayDate >= today),
    monthPreviousForecastRows,
    [],
    selectedMarketCodes
  );
  const currentMonthStatisticsRows = buildRowsWithPrevious(
    monthStatisticsRows.filter((row) => row.stayDate < today),
    monthPreviousStatisticsRows,
    monthPreviousForecastRows,
    selectedMarketCodes
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
    availableMarketCodes: collectMarketCodes(
      monthForecastRows,
      monthPreviousForecastRows,
      monthStatisticsRows,
      monthPreviousStatisticsRows
    ),
    availableSnapshotDates,
    selectedSnapshotDate: resolvedSnapshotDate,
    pickupComparisonDays: normalizedPickupComparisonDays,
    totals: buildTotals(rows),
    rows,
  };
}
