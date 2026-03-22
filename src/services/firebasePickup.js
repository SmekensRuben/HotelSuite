import {
  collection,
  db,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from "../firebaseConfig";

function toIsoDate(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value?.toDate === "function") {
    return value.toDate().toISOString().slice(0, 10);
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
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

function buildCandidateCollections(hotelUid, reportName, reportDate) {
  return [
    ["hotels", hotelUid, "reports", reportName, "date", reportDate, "records"],
    ["hotels", hotelUid, "reports", reportName, reportDate, "records"],
    ["hotels", hotelUid, "reports", reportName, "date", reportDate],
    ["hotels", hotelUid, "reports", reportName, reportDate],
  ];
}

async function getLatestReportDate(hotelUid, reportName) {
  const candidates = [
    ["hotels", hotelUid, "reports", reportName, "date"],
    ["hotels", hotelUid, "reports", reportName],
  ];

  for (const path of candidates) {
    try {
      const snap = await getDocs(query(collection(db, ...path), orderBy(documentId(), "desc"), limit(1)));
      if (!snap.empty) {
        return snap.docs[0].id;
      }
    } catch (error) {
      console.debug(`Pick-up: kon rapportdatum niet ophalen via ${path.join("/")}`, error);
    }
  }

  return null;
}

async function getReportEntries(hotelUid, reportName, reportDate, rangeStart) {
  const collections = buildCandidateCollections(hotelUid, reportName, reportDate);

  for (const path of collections) {
    try {
      const snap = await getDocs(
        query(collection(db, ...path), where(documentId(), ">=", rangeStart), orderBy(documentId(), "asc"))
      );

      if (!snap.empty) {
        return snap.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));
      }
    } catch (error) {
      console.debug(`Pick-up: kon records niet ophalen via ${path.join("/")}`, error);
    }
  }

  return [];
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
  for (let cursor = new Date(`${monthStart}T00:00:00`); cursor <= new Date(`${monthEnd}T00:00:00`); cursor.setDate(cursor.getDate() + 1)) {
    const dateKey = cursor.toISOString().slice(0, 10);
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

  const [statisticsReportDate, forecastReportDate] = await Promise.all([
    getLatestReportDate(hotelUid, "reservationstatistics"),
    getLatestReportDate(hotelUid, "reservationforecast"),
  ]);

  const statisticsPromise = statisticsReportDate
    ? getReportEntries(hotelUid, "reservationstatistics", statisticsReportDate, monthStart)
    : Promise.resolve([]);
  const forecastRangeStart = monthStart > todayIso ? monthStart : todayIso;
  const forecastPromise = forecastReportDate
    ? getReportEntries(hotelUid, "reservationforecast", forecastReportDate, forecastRangeStart)
    : Promise.resolve([]);

  const [statisticsEntries, forecastEntries] = await Promise.all([statisticsPromise, forecastPromise]);

  return aggregatePickupRows({
    statisticsEntries,
    forecastEntries,
    monthStart,
    monthEnd,
    todayIso,
  });
}
