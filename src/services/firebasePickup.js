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

  try {
    const reportDoc = await getDoc(doc(db, "hotels", hotelUid, "reports", reportName));
    console.info("[Pick-Up] Report document probe", {
      hotelUid,
      reportName,
      exists: reportDoc.exists(),
      keys: reportDoc.exists() ? Object.keys(reportDoc.data() || {}) : [],
    });
  } catch (error) {
    console.info("[Pick-Up] Report document probe failed", {
      hotelUid,
      reportName,
      message: error?.message || String(error),
    });
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
  await logPickupSchemaDebug(hotelUid, reportName, dateCandidates);

  for (const snapshotDate of dateCandidates) {
    try {
      const snapshotCollection = collection(
        db,
        "hotels",
        hotelUid,
        "reports",
        reportName,
        snapshotDate
      );
      const snapshotEntries = await getDocs(
        query(snapshotCollection, orderBy(documentId(), "asc"), limit(1))
      );

      console.info("[Pick-Up] Snapshot check", {
        hotelUid,
        reportName,
        snapshotDate,
        foundEntries: snapshotEntries.size,
      });

      if (!snapshotEntries.empty) {
        return snapshotDate;
      }
    } catch (error) {
      console.debug(
        `Pick-up: kon snapshot ${snapshotDate} niet openen voor ${reportName}`,
        error
      );
    }
  }

  return null;
}

async function getReportEntries(hotelUid, reportName, snapshotDate, rangeStart) {
  if (!snapshotDate) return [];

  const reportCollection = collection(
    db,
    "hotels",
    hotelUid,
    "reports",
    reportName,
    snapshotDate
  );

  const reportSnapshot = await getDocs(
    query(
      reportCollection,
      where(documentId(), ">=", rangeStart),
      orderBy(documentId(), "asc")
    )
  );

  console.info("[Pick-Up] Loaded report entries", {
    hotelUid,
    reportName,
    snapshotDate,
    rangeStart,
    entryCount: reportSnapshot.size,
    firstEntry: reportSnapshot.docs[0]?.id || null,
    lastEntry: reportSnapshot.docs[reportSnapshot.docs.length - 1]?.id || null,
  });

  return reportSnapshot.docs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data(),
  }));
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

  const [statisticsSnapshotDate, forecastSnapshotDate] = await Promise.all([
    findLatestSnapshotDate(hotelUid, "reservationstatistics", today),
    findLatestSnapshotDate(hotelUid, "reservationforecast", today),
  ]);

  const statisticsPromise = statisticsSnapshotDate
    ? getReportEntries(hotelUid, "reservationstatistics", statisticsSnapshotDate, monthStart)
    : Promise.resolve([]);
  const forecastRangeStart = monthStart > todayIso ? monthStart : todayIso;
  const forecastPromise = forecastSnapshotDate
    ? getReportEntries(hotelUid, "reservationforecast", forecastSnapshotDate, forecastRangeStart)
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
    statisticsSnapshotDate,
    forecastSnapshotDate,
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
