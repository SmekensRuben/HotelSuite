const { onDocumentCreated, onSchedule, logger, admin, Resend, PDFDocument, RESEND_API_KEY, RESEND_FROM } = require('./config');

const db = admin.firestore();
const SCHEDULED_MAIL_DOC_PATH = 'scheduledMails/scheduledOccupancyMail';
const MANUAL_TRIGGER_COLLECTION = 'manualTriggers';
const REPORT_WINDOW_DAYS = 90;
const DEFAULT_TIMEZONE = 'Europe/Amsterdam';
const PICKUP_COMPARISON_DAYS = [1, 3, 7];

function normalizeDateValue(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return null;
  }

  if (value?.toDate instanceof Function) return value.toDate().toISOString().slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return null;
}

function formatLocalDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatLocalDate(date);
}

function startOfTodayUtc() {
  return formatLocalDate(new Date());
}

function startOfCurrentMonthUtc() {
  const now = new Date();
  return formatLocalDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
}

function monthLabel(dateString, locale = 'nl-NL', timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone }).format(
    new Date(`${dateString}T12:00:00.000Z`)
  );
}

function displayDateLabel(dateString, locale = 'nl-NL', timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone,
  }).format(new Date(`${dateString}T12:00:00.000Z`));
}

function sanitizeEmails(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)));
}

function sanitizeHotelUids(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function getMarketCodeLabel(item) {
  const label =
    item?.marketCode || item?.code || item?.marketSegment || item?.segmentCode || item?.name || item?.id || item?.label;
  if (label == null) return null;
  return String(label).trim() || null;
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
    : sumNumericField(marketCodeEntries, 'roomsSold');
  const totalRevenue = Number.isFinite(Number(payload?.totalRevenue))
    ? Number(payload.totalRevenue)
    : sumNumericField(marketCodeEntries, 'totalRevenue');
  const totalCalculatedRevenue = marketCodeEntries.length
    ? sumNumericField(marketCodeEntries, 'totalCalculatedRevenue')
    : sumCalculatedRevenue(payload?.marketCodes);

  return { roomsSold, totalRevenue, totalCalculatedRevenue, marketCodeEntries };
}

function extractRowsFromSnapshotPayload(payload, fallbackStayDate = null) {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => extractRowsFromSnapshotPayload(entry, fallbackStayDate));
  }
  if (typeof payload !== 'object') return [];

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

function mergeMarketCodeEntries(currentEntries = [], nextEntries = []) {
  const merged = [...currentEntries].reduce((acc, entry) => {
    acc.set(entry.marketCode, { ...entry });
    return acc;
  }, new Map());

  nextEntries.forEach((entry) => {
    const current = merged.get(entry.marketCode) || {
      marketCode: entry.marketCode,
      roomsSold: 0,
      totalRevenue: 0,
      totalCalculatedRevenue: 0,
    };
    current.roomsSold += Number(entry.roomsSold || 0);
    current.totalRevenue += Number(entry.totalRevenue || 0);
    current.totalCalculatedRevenue += Number(entry.totalCalculatedRevenue || 0);
    merged.set(entry.marketCode, current);
  });

  return Array.from(merged.values()).sort((a, b) => a.marketCode.localeCompare(b.marketCode));
}

async function getSnapshotDates(hotelUid, reportType) {
  const snapshotDatesSnap = await db
    .collection('hotels')
    .doc(hotelUid)
    .collection('reports')
    .doc(reportType)
    .collection('snapshotDates')
    .get();

  return snapshotDatesSnap.docs
    .map((docSnap) => normalizeDateValue(docSnap.id) || normalizeDateValue(docSnap.data()?.snapshotDate))
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a));
}

async function getStayDateRows(hotelUid, reportType, snapshotDate, { startDate = null, endDate = null } = {}) {
  if (!snapshotDate) return [];

  let stayDatesQuery = db
    .collection('hotels')
    .doc(hotelUid)
    .collection('reports')
    .doc(reportType)
    .collection('snapshotDates')
    .doc(snapshotDate)
    .collection('stayDates');

  if (startDate && endDate) {
    stayDatesQuery = stayDatesQuery
      .where(admin.firestore.FieldPath.documentId(), '>=', startDate)
      .where(admin.firestore.FieldPath.documentId(), '<=', endDate);
  }

  const stayDatesSnap = await stayDatesQuery.get();

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
      current.marketCodeEntries = mergeMarketCodeEntries(
        current.marketCodeEntries,
        row.marketCodeEntries
      );
      acc.set(row.stayDate, current);
    });

    return acc;
  }, new Map());

  return Array.from(mergedRows.values()).sort((a, b) => a.stayDate.localeCompare(b.stayDate));
}

function resolveSnapshotDate(snapshotDates, selectedSnapshotDate = null) {
  if (!selectedSnapshotDate) return snapshotDates[0] || null;
  return (
    snapshotDates.find((snapshotDate) => snapshotDate === selectedSnapshotDate) || snapshotDates[0] || null
  );
}

function toRowMap(rows = []) {
  return new Map(rows.map((row) => [row.stayDate, row]));
}

function buildMonthlyRevenueOverview(rows = []) {
  return rows.reduce((acc, row) => {
    const monthKey = String(row?.stayDate || '').slice(0, 7);
    if (!monthKey) return acc;

    const current = acc.get(monthKey) || {
      monthKey,
      totalCalculatedRevenue: 0,
      pickup: Object.fromEntries(PICKUP_COMPARISON_DAYS.map((comparisonDays) => [comparisonDays, 0])),
      pickupAvailability: Object.fromEntries(PICKUP_COMPARISON_DAYS.map((comparisonDays) => [comparisonDays, false])),
    };

    current.totalCalculatedRevenue += Number(row?.totalCalculatedRevenue || 0);

    PICKUP_COMPARISON_DAYS.forEach((comparisonDays) => {
      const pickupEntry = row?.pickupCalculatedRevenue?.[comparisonDays];
      if (!pickupEntry?.available) return;
      current.pickup[comparisonDays] += Number(pickupEntry.delta || 0);
      current.pickupAvailability[comparisonDays] = true;
    });

    acc.set(monthKey, current);
    return acc;
  }, new Map());
}

async function getOccupancyRowsForRange(hotelUid, startDate, endDate) {
  const hotelRef = db.collection('hotels').doc(hotelUid);
  const [hotelSnap, settingsSnap, forecastSnapshotDates, statisticsSnapshotDates] = await Promise.all([
    hotelRef.get(),
    hotelRef.collection('settings').doc(hotelUid).get(),
    getSnapshotDates(hotelUid, 'reservationforecast'),
    getSnapshotDates(hotelUid, 'reservationstatistics'),
  ]);

  const hotelData = hotelSnap.exists ? hotelSnap.data() || {} : {};
  const hotelSettings = settingsSnap.exists ? settingsSnap.data() || {} : {};
  const hotelRooms = Number(hotelSettings?.hotelRooms || 0);
  const hotelName = String(hotelData?.hotelName || hotelUid).trim() || hotelUid;
  const today = startOfTodayUtc();

  const forecastSnapshotDate = resolveSnapshotDate(forecastSnapshotDates);
  const statisticsSnapshotDate = resolveSnapshotDate(statisticsSnapshotDates);

  const previousForecastSnapshotDatesByPickup = Object.fromEntries(
    PICKUP_COMPARISON_DAYS.map((comparisonDays) => {
      const forecastSnapshotIndex = forecastSnapshotDates.findIndex(
        (snapshotDate) => snapshotDate === forecastSnapshotDate
      );
      const previousSnapshotDate =
        forecastSnapshotIndex >= 0 ? forecastSnapshotDates[forecastSnapshotIndex + comparisonDays] || null : null;
      return [comparisonDays, previousSnapshotDate];
    })
  );
  const previousStatisticsSnapshotDatesByPickup = Object.fromEntries(
    PICKUP_COMPARISON_DAYS.map((comparisonDays) => {
      const statisticsSnapshotIndex = statisticsSnapshotDates.findIndex(
        (snapshotDate) => snapshotDate === statisticsSnapshotDate
      );
      const previousSnapshotDate =
        statisticsSnapshotIndex >= 0 ? statisticsSnapshotDates[statisticsSnapshotIndex + comparisonDays] || null : null;
      return [comparisonDays, previousSnapshotDate];
    })
  );

  const [forecastRows, statisticsRows, ...previousRowsList] = await Promise.all([
    getStayDateRows(hotelUid, 'reservationforecast', forecastSnapshotDate, { startDate, endDate }),
    getStayDateRows(hotelUid, 'reservationstatistics', statisticsSnapshotDate, { startDate, endDate }),
    ...PICKUP_COMPARISON_DAYS.map((comparisonDays) =>
      getStayDateRows(hotelUid, 'reservationforecast', previousForecastSnapshotDatesByPickup[comparisonDays], {
        startDate,
        endDate,
      })
    ),
    ...PICKUP_COMPARISON_DAYS.map((comparisonDays) =>
      getStayDateRows(hotelUid, 'reservationstatistics', previousStatisticsSnapshotDatesByPickup[comparisonDays], {
        startDate,
        endDate,
      })
    )
  ]);

  const forecastRowsByDate = toRowMap(forecastRows);
  const statisticsRowsByDate = toRowMap(statisticsRows);
  const previousForecastRowsList = previousRowsList.slice(0, PICKUP_COMPARISON_DAYS.length);
  const previousStatisticsRowsList = previousRowsList.slice(PICKUP_COMPARISON_DAYS.length);
  const previousForecastRowsByPickup = Object.fromEntries(
    PICKUP_COMPARISON_DAYS.map((comparisonDays, index) => [comparisonDays, toRowMap(previousForecastRowsList[index])])
  );
  const previousStatisticsRowsByPickup = Object.fromEntries(
    PICKUP_COMPARISON_DAYS.map((comparisonDays, index) => [comparisonDays, toRowMap(previousStatisticsRowsList[index])])
  );

  const rows = [];
  for (let cursor = startDate; cursor <= endDate; cursor = addDays(cursor, 1)) {
    const isPastDate = cursor < today;
    const activeRow = isPastDate ? statisticsRowsByDate.get(cursor) : forecastRowsByDate.get(cursor);
    const roomsSold = Number(activeRow?.roomsSold || 0);
    const totalCalculatedRevenue = Number(activeRow?.totalCalculatedRevenue || 0);
    const occupancy = hotelRooms > 0 ? (roomsSold / hotelRooms) * 100 : 0;
    const pickup = Object.fromEntries(
      PICKUP_COMPARISON_DAYS.map((comparisonDays) => {
        const previousRowsByDate = isPastDate
          ? previousStatisticsRowsByPickup[comparisonDays]
          : previousForecastRowsByPickup[comparisonDays];
        const previousSnapshotDate = isPastDate
          ? previousStatisticsSnapshotDatesByPickup[comparisonDays]
          : previousForecastSnapshotDatesByPickup[comparisonDays];
        if (!previousSnapshotDate) {
          return [comparisonDays, { available: false, delta: null }];
        }

        const previousRoomsSold = Number(previousRowsByDate.get(cursor)?.roomsSold || 0);
        return [comparisonDays, { available: true, delta: roomsSold - previousRoomsSold }];
      })
    );

    const pickupCalculatedRevenue = Object.fromEntries(
      PICKUP_COMPARISON_DAYS.map((comparisonDays) => {
        const previousRowsByDate = isPastDate
          ? previousStatisticsRowsByPickup[comparisonDays]
          : previousForecastRowsByPickup[comparisonDays];
        const previousSnapshotDate = isPastDate
          ? previousStatisticsSnapshotDatesByPickup[comparisonDays]
          : previousForecastSnapshotDatesByPickup[comparisonDays];
        if (!previousSnapshotDate) {
          return [comparisonDays, { available: false, delta: null }];
        }

        const previousCalculatedRevenue = Number(previousRowsByDate.get(cursor)?.totalCalculatedRevenue || 0);
        return [comparisonDays, { available: true, delta: totalCalculatedRevenue - previousCalculatedRevenue }];
      })
    );

    rows.push({ stayDate: cursor, roomsSold, occupancy, totalCalculatedRevenue, pickup, pickupCalculatedRevenue });
  }

  const monthlyRevenueOverview = buildMonthlyRevenueOverview(rows);

  return {
    hotelUid,
    hotelName,
    hotelRooms,
    rows,
    forecastSnapshotDate,
    statisticsSnapshotDate,
    previousForecastSnapshotDatesByPickup,
    previousStatisticsSnapshotDatesByPickup,
    monthlyRevenueOverview,
  };
}

function formatPercentageValue(value) {
  return `${Number(value || 0).toLocaleString('nl-NL', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function formatPickupDelta(value) {
  if (value == null) return '-';
  const normalized = Number(value || 0);
  return `${normalized > 0 ? '+' : ''}${normalized.toLocaleString('nl-NL')}`;
}

function formatCurrencyValue(value) {
  return `€ ${Number(value || 0).toLocaleString('nl-NL', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function drawCellText(doc, text, x, y, width, options = {}) {
  doc.text(text, x + 4, y + 4, {
    width: width - 8,
    align: options.align || 'left',
    ellipsis: options.ellipsis || false,
  });
}

function buildPdfBuffer({ startDate, endDate, hotels }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A3', layout: 'landscape', margin: 28 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const hotelCount = Math.max(hotels.length, 1);
    const dateColumnWidth = 82;
    const rowHeight = 18;
    const headerRowHeight = 20;
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const hotelAreaWidth = Math.max(pageWidth - dateColumnWidth, 0);
    const hotelGroupWidth = hotelAreaWidth / hotelCount;
    const subColumnWidth = hotelGroupWidth / 4;
    const tableTop = 118;
    const monthlyTableTop = 110;

    const renderPageHeader = () => {
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#111827');
      doc.text('Occupancy overzicht vanaf eerste dag huidige maand', doc.page.margins.left, doc.page.margins.top);
      doc.moveDown(0.15);
      doc.font('Helvetica').fontSize(10).fillColor('#4b5563');
      doc.text(`Periode: ${displayDateLabel(startDate)} t/m ${displayDateLabel(endDate)}`);
      doc.text(
        `Aangemaakt op: ${new Intl.DateTimeFormat('nl-NL', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: DEFAULT_TIMEZONE,
        }).format(new Date())}`
      );
      doc.fillColor('#111827');
    };

    const renderTableHeader = (y) => {
      doc.save();
      doc.rect(doc.page.margins.left, y, dateColumnWidth, headerRowHeight * 2).fill('#e5e7eb');
      doc.fillColor('#111827').font('Helvetica-Bold').fontSize(8);
      drawCellText(doc, 'Datum', doc.page.margins.left, y + 8, dateColumnWidth);

      hotels.forEach((hotel, hotelIndex) => {
        const groupX = doc.page.margins.left + dateColumnWidth + hotelIndex * hotelGroupWidth;
        doc.rect(groupX, y, hotelGroupWidth, headerRowHeight).fill('#dbeafe');
        doc.fillColor('#1e3a8a').font('Helvetica-Bold').fontSize(8);
        drawCellText(doc, hotel.hotelName, groupX, y + 2, hotelGroupWidth, { ellipsis: true });

        const subHeaders = ['Occ %', 'PU -1', 'PU -3', 'PU -7'];
        subHeaders.forEach((subHeader, subIndex) => {
          const subX = groupX + subIndex * subColumnWidth;
          doc.rect(subX, y + headerRowHeight, subColumnWidth, headerRowHeight).fill('#eff6ff');
          doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(7);
          drawCellText(doc, subHeader, subX, y + headerRowHeight + 2, subColumnWidth, { align: 'center' });
        });
      });

      doc.restore();
      doc.strokeColor('#cbd5e1').lineWidth(0.5);
      doc.rect(doc.page.margins.left, y, pageWidth, headerRowHeight * 2).stroke();

      doc.strokeColor('#94a3b8').lineWidth(0.8);
      doc
        .moveTo(doc.page.margins.left + dateColumnWidth, y)
        .lineTo(doc.page.margins.left + dateColumnWidth, y + headerRowHeight * 2)
        .stroke();
      hotels.forEach((_, hotelIndex) => {
        const groupBoundaryX = doc.page.margins.left + dateColumnWidth + (hotelIndex + 1) * hotelGroupWidth;
        doc.moveTo(groupBoundaryX, y).lineTo(groupBoundaryX, y + headerRowHeight * 2).stroke();
      });
    };

    const renderRow = (dateString, rowIndex, y) => {
      if (rowIndex % 2 === 0) {
        doc.save();
        doc.rect(doc.page.margins.left, y, pageWidth, rowHeight).fill('#f8fafc');
        doc.restore();
      }

      doc.fillColor('#111827').font('Helvetica').fontSize(8);
      drawCellText(doc, displayDateLabel(dateString), doc.page.margins.left, y + 1, dateColumnWidth);

      hotels.forEach((hotel, hotelIndex) => {
        const hotelRow = hotel.rowsByDate.get(dateString) || null;
        const groupX = doc.page.margins.left + dateColumnWidth + hotelIndex * hotelGroupWidth;
        const values = [
          formatPercentageValue(hotelRow?.occupancy || 0),
          formatPickupDelta(hotelRow?.pickup?.[1]?.delta),
          formatPickupDelta(hotelRow?.pickup?.[3]?.delta),
          formatPickupDelta(hotelRow?.pickup?.[7]?.delta),
        ];

        values.forEach((value, valueIndex) => {
          const x = groupX + valueIndex * subColumnWidth;
          drawCellText(doc, value, x, y + 1, subColumnWidth, { align: 'right' });
        });
      });

      doc.strokeColor('#cbd5e1').lineWidth(0.6);
      hotels.forEach((_, hotelIndex) => {
        const groupBoundaryX = doc.page.margins.left + dateColumnWidth + (hotelIndex + 1) * hotelGroupWidth;
        doc.moveTo(groupBoundaryX, y).lineTo(groupBoundaryX, y + rowHeight).stroke();
      });

      doc.strokeColor('#e5e7eb').lineWidth(0.5);
      doc.moveTo(doc.page.margins.left, y + rowHeight).lineTo(doc.page.margins.left + pageWidth, y + rowHeight).stroke();
    };

    const renderMonthlyRevenueHeader = () => {
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#111827');
      doc.text('Maandoverzicht calculated total revenue', doc.page.margins.left, doc.page.margins.top);
      doc.moveDown(0.15);
      doc.font('Helvetica').fontSize(10).fillColor('#4b5563');
      doc.text(`Periode: ${displayDateLabel(startDate)} t/m ${displayDateLabel(endDate)}`);
      doc.fillColor('#111827');
    };

    const renderMonthlyTableHeader = (y) => {
      doc.save();
      doc.rect(doc.page.margins.left, y, dateColumnWidth, headerRowHeight * 2).fill('#e5e7eb');
      doc.fillColor('#111827').font('Helvetica-Bold').fontSize(8);
      drawCellText(doc, 'Maand', doc.page.margins.left, y + 8, dateColumnWidth);

      hotels.forEach((hotel, hotelIndex) => {
        const groupX = doc.page.margins.left + dateColumnWidth + hotelIndex * hotelGroupWidth;
        doc.rect(groupX, y, hotelGroupWidth, headerRowHeight).fill('#d1fae5');
        doc.fillColor('#065f46').font('Helvetica-Bold').fontSize(8);
        drawCellText(doc, hotel.hotelName, groupX, y + 2, hotelGroupWidth, { ellipsis: true });

        const subHeaders = ['Calc Rev', 'PU Rev -1', 'PU Rev -3', 'PU Rev -7'];
        subHeaders.forEach((subHeader, subIndex) => {
          const subX = groupX + subIndex * subColumnWidth;
          doc.rect(subX, y + headerRowHeight, subColumnWidth, headerRowHeight).fill('#ecfdf5');
          doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(7);
          drawCellText(doc, subHeader, subX, y + headerRowHeight + 2, subColumnWidth, { align: 'center' });
        });
      });

      doc.restore();
      doc.strokeColor('#cbd5e1').lineWidth(0.5);
      doc.rect(doc.page.margins.left, y, pageWidth, headerRowHeight * 2).stroke();

      doc.strokeColor('#94a3b8').lineWidth(0.8);
      doc
        .moveTo(doc.page.margins.left + dateColumnWidth, y)
        .lineTo(doc.page.margins.left + dateColumnWidth, y + headerRowHeight * 2)
        .stroke();
      hotels.forEach((_, hotelIndex) => {
        const groupBoundaryX = doc.page.margins.left + dateColumnWidth + (hotelIndex + 1) * hotelGroupWidth;
        doc.moveTo(groupBoundaryX, y).lineTo(groupBoundaryX, y + headerRowHeight * 2).stroke();
      });
    };

    const renderMonthlyRevenueRow = (monthKey, rowIndex, y) => {
      if (rowIndex % 2 === 0) {
        doc.save();
        doc.rect(doc.page.margins.left, y, pageWidth, rowHeight).fill('#f8fafc');
        doc.restore();
      }

      doc.fillColor('#111827').font('Helvetica').fontSize(8);
      drawCellText(doc, monthLabel(`${monthKey}-01`), doc.page.margins.left, y + 1, dateColumnWidth);

      hotels.forEach((hotel, hotelIndex) => {
        const monthlyMetrics = hotel.monthlyRevenueOverview.get(monthKey) || null;
        const groupX = doc.page.margins.left + dateColumnWidth + hotelIndex * hotelGroupWidth;
        const values = [
          formatCurrencyValue(monthlyMetrics?.totalCalculatedRevenue || 0),
          monthlyMetrics?.pickupAvailability?.[1]
            ? formatCurrencyValue(monthlyMetrics.pickup?.[1] || 0)
            : '-',
          monthlyMetrics?.pickupAvailability?.[3]
            ? formatCurrencyValue(monthlyMetrics.pickup?.[3] || 0)
            : '-',
          monthlyMetrics?.pickupAvailability?.[7]
            ? formatCurrencyValue(monthlyMetrics.pickup?.[7] || 0)
            : '-',
        ];

        values.forEach((value, valueIndex) => {
          const x = groupX + valueIndex * subColumnWidth;
          drawCellText(doc, value, x, y + 1, subColumnWidth, { align: 'right' });
        });
      });

      doc.strokeColor('#cbd5e1').lineWidth(0.6);
      hotels.forEach((_, hotelIndex) => {
        const groupBoundaryX = doc.page.margins.left + dateColumnWidth + (hotelIndex + 1) * hotelGroupWidth;
        doc.moveTo(groupBoundaryX, y).lineTo(groupBoundaryX, y + rowHeight).stroke();
      });

      doc.strokeColor('#e5e7eb').lineWidth(0.5);
      doc.moveTo(doc.page.margins.left, y + rowHeight).lineTo(doc.page.margins.left + pageWidth, y + rowHeight).stroke();
    };

    const allDates = [];
    for (let cursor = startDate; cursor <= endDate; cursor = addDays(cursor, 1)) {
      allDates.push(cursor);
    }

    hotels.forEach((hotel) => {
      hotel.rowsByDate = toRowMap(hotel.rows);
      hotel.monthlyRevenueOverview = hotel.monthlyRevenueOverview || new Map();
    });

    renderPageHeader();
    let y = tableTop;
    let currentMonth = null;
    renderTableHeader(y);
    y += headerRowHeight * 2;

    allDates.forEach((dateString, rowIndex) => {
      const monthKey = dateString.slice(0, 7);
      if (monthKey !== currentMonth) {
        currentMonth = monthKey;
        if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
          doc.addPage({ size: 'A3', layout: 'landscape', margin: 28 });
          renderPageHeader();
          y = tableTop;
          renderTableHeader(y);
          y += headerRowHeight * 2;
        }

        doc.save();
        doc.rect(doc.page.margins.left, y, pageWidth, rowHeight).fill('#dbeafe');
        doc.restore();
        doc.fillColor('#1e3a8a').font('Helvetica-Bold').fontSize(8);
        drawCellText(doc, monthLabel(dateString), doc.page.margins.left, y + 1, pageWidth);
        doc.strokeColor('#cbd5e1').lineWidth(0.6);
        hotels.forEach((_, hotelIndex) => {
          const groupBoundaryX = doc.page.margins.left + dateColumnWidth + (hotelIndex + 1) * hotelGroupWidth;
          doc.moveTo(groupBoundaryX, y).lineTo(groupBoundaryX, y + rowHeight).stroke();
        });
        y += rowHeight;
      }

      if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage({ size: 'A3', layout: 'landscape', margin: 28 });
        renderPageHeader();
        y = tableTop;
        renderTableHeader(y);
        y += headerRowHeight * 2;
      }

      renderRow(dateString, rowIndex, y);
      y += rowHeight;
    });

    const monthKeys = [];
    for (let cursor = startDate; cursor <= endDate; cursor = addDays(cursor, 1)) {
      const monthKey = cursor.slice(0, 7);
      if (!monthKeys.includes(monthKey)) monthKeys.push(monthKey);
    }

    doc.addPage({ size: 'A3', layout: 'landscape', margin: 28 });
    renderMonthlyRevenueHeader();
    y = monthlyTableTop;
    renderMonthlyTableHeader(y);
    y += headerRowHeight * 2;

    monthKeys.forEach((monthKey, rowIndex) => {
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage({ size: 'A3', layout: 'landscape', margin: 28 });
        renderMonthlyRevenueHeader();
        y = monthlyTableTop;
        renderMonthlyTableHeader(y);
        y += headerRowHeight * 2;
      }

      renderMonthlyRevenueRow(monthKey, rowIndex, y);
      y += rowHeight;
    });

    doc.end();
  });
}

async function sendOccupancyMail({ scheduleConfig, reason = 'scheduled', triggerId = null }) {
  const hotelUids = sanitizeHotelUids(scheduleConfig?.hotelUid);
  const to = sanitizeEmails(scheduleConfig?.mailto);
  if (!hotelUids.length) throw new Error('Geen hotelUid configuratie gevonden in scheduledOccupancyMail');
  if (!to.length) throw new Error('Geen geldige mailto adressen gevonden in scheduledOccupancyMail');

  const resendApiKey = String(RESEND_API_KEY.value() || '').trim();
  const resendFrom = String(RESEND_FROM.value() || '').trim();
  if (!resendApiKey) throw new Error('Missing RESEND_API_KEY secret');
  if (!resendFrom) throw new Error('Missing RESEND_FROM secret');

  const today = startOfTodayUtc();
  const startDate = startOfCurrentMonthUtc();
  const endDate = addDays(today, REPORT_WINDOW_DAYS - 1);
  const hotels = await Promise.all(
    hotelUids.map((hotelUid) => getOccupancyRowsForRange(hotelUid, startDate, endDate))
  );
  const pdfBuffer = await buildPdfBuffer({ startDate, endDate, hotels });
  const resend = new Resend(resendApiKey);

  const subject = `Occupancy overzicht ${displayDateLabel(startDate)} - ${displayDateLabel(endDate)}`;
  const hotelNames = hotels.map((hotel) => hotel.hotelName).join(', ');

  const response = await resend.emails.send({
    from: resendFrom,
    to,
    subject,
    text:
      `In de bijlage vind je het occupancy overzicht vanaf de eerste dag van de huidige maand ` +
      `voor: ${hotelNames}. Per hotel zijn occupancy en pickup rooms sold vs. -1, -3 en -7 ` +
      `toegevoegd indien beschikbaar. Daarnaast bevat de bijlage per maand calculated total revenue ` +
      `en pickup op calculated total revenue voor -1, -3 en -7 dagen.\n\n` +
      `Verstuurd via ${reason}${triggerId ? ` (trigger: ${triggerId})` : ''}.`,
    attachments: [
      {
        filename: `occupancy-overzicht-${startDate}-tot-${endDate}.pdf`,
        content: pdfBuffer.toString('base64'),
      },
    ],
  });

  await db.collection('scheduledMails').doc('scheduledOccupancyMail').set(
    {
      lastSentAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSentReason: reason,
      lastTriggerId: triggerId || null,
      lastMailId: response?.data?.id || null,
      lastSentTo: to,
      lastHotelUid: hotelUids,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  logger.info('Occupancy mail sent', { reason, triggerId, hotelCount: hotelUids.length, toCount: to.length });
  return response;
}

const sendScheduledOccupancyMail = onSchedule(
  { schedule: '0 6 * * *', timeZone: DEFAULT_TIMEZONE, secrets: [RESEND_API_KEY, RESEND_FROM] },
  async () => {
    const scheduleSnap = await db.doc(SCHEDULED_MAIL_DOC_PATH).get();
    if (!scheduleSnap.exists) {
      logger.warn('scheduledOccupancyMail config not found; skipping scheduled send');
      return;
    }

    await sendOccupancyMail({ scheduleConfig: scheduleSnap.data() || {}, reason: 'scheduled' });
  }
);

const runScheduledOccupancyMailNow = onDocumentCreated(
  {
    document: `${SCHEDULED_MAIL_DOC_PATH}/${MANUAL_TRIGGER_COLLECTION}/{triggerId}`,
    secrets: [RESEND_API_KEY, RESEND_FROM],
  },
  async (event) => {
    const triggerId = event.params.triggerId;
    const triggerRef = event.data.ref;
    const triggerData = event.data.data() || {};

    try {
      await triggerRef.set(
        { status: 'processing', startedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      const scheduleSnap = await db.doc(SCHEDULED_MAIL_DOC_PATH).get();
      if (!scheduleSnap.exists) throw new Error('scheduledOccupancyMail config not found');

      await sendOccupancyMail({ scheduleConfig: scheduleSnap.data() || {}, reason: 'manual', triggerId });
      await triggerRef.set(
        {
          status: 'completed',
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          requestedBy: triggerData.requestedBy || null,
        },
        { merge: true }
      );
    } catch (error) {
      logger.error('Manual occupancy mail trigger failed', {
        triggerId,
        message: error?.message || String(error),
      });
      await triggerRef.set(
        {
          status: 'failed',
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          error: error?.message || String(error),
        },
        { merge: true }
      );
      throw error;
    }
  }
);

module.exports = { sendScheduledOccupancyMail, runScheduledOccupancyMailNow };
