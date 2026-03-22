import {
  collection,
  db,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from "../firebaseConfig";

function formatLocalDateParts(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toIsoDate(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value?.toDate === "function") {
    return formatLocalDateParts(value.toDate());
  }
  if (value instanceof Date) {
    return formatLocalDateParts(value);
  }
  return null;
}

function sumMarketCodes(marketCodes = []) {
  return marketCodes.reduce(
    (totals, entry) => ({
      roomsSold: totals.roomsSold + Number(entry?.roomsSold || 0),
      totalRevenue: totals.totalRevenue + Number(entry?.totalRevenue || 0),
    }),
    { roomsSold: 0, totalRevenue: 0 }
  );
}

export function listSnapshotDateCandidates(baseDate = new Date(), lookbackDays = 31) {
  const normalizedBaseDate = new Date(baseDate);
  normalizedBaseDate.setHours(0, 0, 0, 0);

  return Array.from({ length: lookbackDays + 1 }, (_, offset) => {
    const candidate = new Date(normalizedBaseDate);
    candidate.setDate(candidate.getDate() - offset);
    return formatLocalDateParts(candidate);
  });
}

function buildReportCollectionCandidates(hotelUid, reportName) {
  return [
    ["hotels", hotelUid, "reports", "operaReports", reportName],
    ["hotels", hotelUid, "reports", reportName],
  ];
}

function parseSnapshotDocument(snapshotDate, data = {}) {
  const nestedStayDateEntries = Object.entries(data).filter(([key, value]) => {
    return /^\d{4}-\d{2}-\d{2}$/.test(key) && value && typeof value === "object";
  });

  if (nestedStayDateEntries.length > 0) {
    return nestedStayDateEntries.map(([stayDate, value]) => ({
      id: stayDate,
      daterange: stayDate,
      ...value,
    }));
  }

  if (Array.isArray(data?.marketCodes)) {
    return [
      {
        id: snapshotDate,
        daterange: snapshotDate,
        ...data,
      },
    ];
  }

  return [];
}

async function logPickupSchemaDebug(hotelUid, reportName, dateCandidates = []) {
  try {
    const reportsCollection = await getDocs(collection(db, "hotels", hotelUid, "reports"));
    console.info("[Pick-Up] Reports collection docs", {
      hotelUid,
      reportName,
      docs: reportsCollection.docs.map((docSnap) => docSnap.id),
    });
  } catch (error) {
    console.info("[Pick-Up] Reports collection probe failed", {
      hotelUid,
      reportName,
      message: error?.message || String(error),
    });
  }

  for (const path of buildReportCollectionCandidates(hotelUid, reportName)) {
    try {
      const snapshotDocs = await getDocs(
        query(collection(db, ...path), orderBy(documentId(), "desc"), limit(3))
      );
      console.info("[Pick-Up] Report collection probe", {
        hotelUid,
        reportName,
        path: path.join("/"),
        docs: snapshotDocs.docs.map((docSnap) => docSnap.id),
      });
    } catch (error) {
      console.info("[Pick-Up] Report collection probe failed", {
        hotelUid,
        reportName,
        path: path.join("/"),
        message: error?.message || String(error),
      });
    }
  }

  if (dateCandidates.length > 0) {
    console.info("[Pick-Up] Snapshot candidates", {
      hotelUid,
      reportName,
      candidates: dateCandidates.slice(0, 7),
    });
  }
}

async function findLatestSnapshotDate(hotelUid, reportName, baseDate = new Date(), lookbackDays = 31) {
  const dateCandidates = listSnapshotDateCandidates(baseDate, lookbackDays);
  const collectionPaths = buildReportCollectionCandidates(hotelUid, reportName);

  await logPickupSchemaDebug(hotelUid, reportName, dateCandidates);

  for (const path of collectionPaths) {
    try {
      const snapshotDocs = await getDocs(
        query(collection(db, ...path), orderBy(documentId(), "desc"), limit(31))
      );
      const docIds = snapshotDocs.docs.map((docSnap) => docSnap.id);
      const match = dateCandidates.find((candidate) => docIds.includes(candidate));

      console.info("[Pick-Up] Snapshot doc scan", {
        hotelUid,
        reportName,
        path: path.join("/"),
        scannedDocs: docIds.slice(0, 10),
        matchedSnapshot: match || null,
      });

      if (match) {
        return { snapshotDate: match, path };
      }
    } catch (error) {
      console.info("[Pick-Up] Snapshot doc scan failed", {
        hotelUid,
        reportName,
        path: path.join("/"),
        message: error?.message || String(error),
      });
    }
  }

  return { snapshotDate: null, path: null };
}

async function getReportEntries(hotelUid, reportName, snapshotDate, rangeStart, path) {
  if (!snapshotDate || !path?.length) return [];

  const snapshotDocRef = doc(db, ...path, snapshotDate);
  const snapshotDoc = await getDoc(snapshotDocRef);

  console.info("[Pick-Up] Snapshot document read", {
    hotelUid,
    reportName,
    path: [...path, snapshotDate].join("/"),
    exists: snapshotDoc.exists(),
    topLevelKeys: snapshotDoc.exists() ? Object.keys(snapshotDoc.data() || {}).slice(0, 10) : [],
  });

  if (!snapshotDoc.exists()) {
    return [];
  }

  const parsedEntries = parseSnapshotDocument(snapshotDate, snapshotDoc.data()).filter(
    (entry) => (entry?.daterange || entry?.id) >= rangeStart
  );

  console.info("[Pick-Up] Parsed snapshot entries", {
    hotelUid,
    reportName,
    snapshotDate,
    rangeStart,
    entryCount: parsedEntries.length,
    firstEntry: parsedEntries[0]?.daterange || parsedEntries[0]?.id || null,
    lastEntry:
      parsedEntries[parsedEntries.length - 1]?.daterange ||
      parsedEntries[parsedEntries.length - 1]?.id ||
      null,
  });

  return parsedEntries;
}

export function aggregatePickupRows({
  statisticsEntries = [],
  forecastEntries = [],
  monthStart,
  monthEnd,
  todayIso,
}) {
  const totalsByDate = new Map();

  const addEntry = (entry, source) => {
    const dateKey = entry?.daterange || entry?.date || entry?.id;
    if (!dateKey || dateKey < monthStart || dateKey > monthEnd) return;
    if (source === "reservationstatistics" && dateKey >= todayIso) return;
    if (source === "reservationforecast" && dateKey < todayIso) return;

    const aggregated = sumMarketCodes(entry?.marketCodes);
    totalsByDate.set(dateKey, {
      date: dateKey,
      roomsSold: aggregated.roomsSold,
      totalRevenue: aggregated.totalRevenue,
      source,
    });
  };

  statisticsEntries.forEach((entry) => addEntry(entry, "reservationstatistics"));
  forecastEntries.forEach((entry) => addEntry(entry, "reservationforecast"));

  const rows = [];
  for (
    let cursor = new Date(`${monthStart}T00:00:00`);
    cursor <= new Date(`${monthEnd}T00:00:00`);
    cursor.setDate(cursor.getDate() + 1)
  ) {
    const dateKey = formatLocalDateParts(cursor);
    rows.push(
      totalsByDate.get(dateKey) || {
        date: dateKey,
        roomsSold: 0,
        totalRevenue: 0,
        source: dateKey < todayIso ? "reservationstatistics" : "reservationforecast",
      }
    );
  }

  return rows;
}

export async function getPickupForMonth(hotelUid, monthDate = new Date()) {
  if (!hotelUid) return [];

  const current = new Date(monthDate);
  current.setHours(0, 0, 0, 0);

  const monthStartDate = new Date(current.getFullYear(), current.getMonth(), 1);
  const monthEndDate = new Date(current.getFullYear(), current.getMonth() + 1, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const monthStart = toIsoDate(monthStartDate);
  const monthEnd = toIsoDate(monthEndDate);
  const todayIso = toIsoDate(today);

  const [statisticsSnapshotInfo, forecastSnapshotInfo] = await Promise.all([
    findLatestSnapshotDate(hotelUid, "reservationstatistics", today),
    findLatestSnapshotDate(hotelUid, "reservationforecast", today),
  ]);

  const statisticsPromise = statisticsSnapshotInfo.snapshotDate
    ? getReportEntries(
        hotelUid,
        "reservationstatistics",
        statisticsSnapshotInfo.snapshotDate,
        monthStart,
        statisticsSnapshotInfo.path
      )
    : Promise.resolve([]);
  const forecastRangeStart = monthStart > todayIso ? monthStart : todayIso;
  const forecastPromise = forecastSnapshotInfo.snapshotDate
    ? getReportEntries(
        hotelUid,
        "reservationforecast",
        forecastSnapshotInfo.snapshotDate,
        forecastRangeStart,
        forecastSnapshotInfo.path
      )
    : Promise.resolve([]);

  const [statisticsEntries, forecastEntries] = await Promise.all([
    statisticsPromise,
    forecastPromise,
  ]);

  console.info("[Pick-Up] Month load summary", {
    hotelUid,
    monthStart,
    monthEnd,
    todayIso,
    statisticsSnapshotDate: statisticsSnapshotInfo.snapshotDate,
    statisticsPath: statisticsSnapshotInfo.path?.join("/") || null,
    forecastSnapshotDate: forecastSnapshotInfo.snapshotDate,
    forecastPath: forecastSnapshotInfo.path?.join("/") || null,
    statisticsEntries: statisticsEntries.length,
    forecastEntries: forecastEntries.length,
  });

  return aggregatePickupRows({
    statisticsEntries,
    forecastEntries,
    monthStart,
    monthEnd,
    todayIso,
  });
}
