const { onDocumentCreated, onSchedule, logger, admin, Resend, PDFDocument, RESEND_API_KEY, RESEND_FROM } = require('./config');

const db = admin.firestore();
const SCHEDULED_MAIL_DOC_PATH = 'scheduledMails/scheduledOccupancyMail';
const MANUAL_TRIGGER_COLLECTION = 'manualTriggers';
const REPORT_WINDOW_DAYS = 90;
const DEFAULT_TIMEZONE = 'Europe/Amsterdam';

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
  return marketCodes.reduce((total, item) => total + Number(item?.roomsSold || 0) * Number(item?.avgRoomRevenue || 0), 0);
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
  if (Array.isArray(payload)) return payload.flatMap((entry) => extractRowsFromSnapshotPayload(entry, fallbackStayDate));
  if (typeof payload !== 'object') return [];

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
  const snapshotDatesSnap = await db.collection('hotels').doc(hotelUid).collection('reports').doc(reportType).collection('snapshotDates').get();
  return snapshotDatesSnap.docs
    .map((docSnap) => normalizeDateValue(docSnap.id) || normalizeDateValue(docSnap.data()?.snapshotDate))
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a));
}

async function getStayDateRows(hotelUid, reportType, snapshotDate) {
  if (!snapshotDate) return [];
  const stayDatesSnap = await db
    .collection('hotels').doc(hotelUid)
    .collection('reports').doc(reportType)
    .collection('snapshotDates').doc(snapshotDate)
    .collection('stayDates')
    .get();

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

function resolveSnapshotDate(snapshotDates) {
  return snapshotDates[0] || null;
}

async function getOccupancyRowsForRange(hotelUid, startDate, endDate) {
  const [forecastSnapshotDates, statisticsSnapshotDates, settingsSnap] = await Promise.all([
    getSnapshotDates(hotelUid, 'reservationforecast'),
    getSnapshotDates(hotelUid, 'reservationstatistics'),
    db.collection('hotels').doc(hotelUid).collection('settings').doc(hotelUid).get(),
  ]);

  const forecastSnapshotDate = resolveSnapshotDate(forecastSnapshotDates);
  const statisticsSnapshotDate = resolveSnapshotDate(statisticsSnapshotDates);
  const [forecastRows, statisticsRows] = await Promise.all([
    getStayDateRows(hotelUid, 'reservationforecast', forecastSnapshotDate),
    getStayDateRows(hotelUid, 'reservationstatistics', statisticsSnapshotDate),
  ]);

  const hotelSettings = settingsSnap.exists ? settingsSnap.data() || {} : {};
  const hotelRooms = Number(hotelSettings?.hotelRooms || 0);
  const hotelName = String(hotelSettings?.hotelName || hotelUid).trim() || hotelUid;
  const rowsByDate = new Map();
  const today = startOfTodayUtc();

  statisticsRows.filter((row) => row.stayDate >= startDate && row.stayDate <= endDate && row.stayDate < today).forEach((row) => {
    rowsByDate.set(row.stayDate, row);
  });
  forecastRows.filter((row) => row.stayDate >= startDate && row.stayDate <= endDate && row.stayDate >= today).forEach((row) => {
    rowsByDate.set(row.stayDate, row);
  });

  const dates = [];
  for (let cursor = startDate; cursor <= endDate; cursor = addDays(cursor, 1)) {
    const row = rowsByDate.get(cursor);
    const roomsSold = Number(row?.roomsSold || 0);
    const occupancy = hotelRooms > 0 ? (roomsSold / hotelRooms) * 100 : 0;
    dates.push({ stayDate: cursor, roomsSold, occupancy });
  }

  return {
    hotelUid,
    hotelName,
    hotelRooms,
    rows: dates,
    forecastSnapshotDate,
    statisticsSnapshotDate,
  };
}

function buildPdfBuffer({ startDate, endDate, hotels }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const dateColumnWidth = 90;
    const hotelColumnWidth = (pageWidth - dateColumnWidth) / Math.max(hotels.length, 1);
    const rowHeight = 18;
    const tableTop = 120;

    const renderHeader = () => {
      doc.font('Helvetica-Bold').fontSize(16).text('Occupancy overzicht komende 90 dagen', { align: 'left' });
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(10).fillColor('#4b5563').text(`Periode: ${displayDateLabel(startDate)} t/m ${displayDateLabel(endDate)}`);
      doc.text(`Aangemaakt op: ${new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium', timeStyle: 'short', timeZone: DEFAULT_TIMEZONE }).format(new Date())}`);
      doc.fillColor('#111827');
    };

    const renderTableHeader = (y) => {
      doc.rect(doc.page.margins.left, y, pageWidth, rowHeight).fill('#e5e7eb');
      doc.fillColor('#111827').font('Helvetica-Bold').fontSize(9);
      doc.text('Datum', doc.page.margins.left + 6, y + 5, { width: dateColumnWidth - 12 });
      hotels.forEach((hotel, index) => {
        const x = doc.page.margins.left + dateColumnWidth + (index * hotelColumnWidth);
        doc.text(hotel.hotelName, x + 6, y + 5, { width: hotelColumnWidth - 12, ellipsis: true });
      });
      doc.font('Helvetica');
    };

    const rows = [];
    for (let cursor = startDate; cursor <= endDate; cursor = addDays(cursor, 1)) {
      rows.push(cursor);
    }

    let y = tableTop;
    let currentMonth = null;
    renderHeader();
    renderTableHeader(y);
    y += rowHeight;

    rows.forEach((dateString, rowIndex) => {
      const month = dateString.slice(0, 7);
      if (month !== currentMonth) {
        currentMonth = month;
        if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
          doc.addPage({ size: 'A4', layout: 'landscape', margin: 32 });
          renderHeader();
          y = tableTop;
          renderTableHeader(y);
          y += rowHeight;
        }
        doc.rect(doc.page.margins.left, y, pageWidth, rowHeight).fill('#dbeafe');
        doc.fillColor('#1e3a8a').font('Helvetica-Bold').fontSize(9).text(monthLabel(dateString), doc.page.margins.left + 6, y + 5, { width: pageWidth - 12 });
        y += rowHeight;
      }

      if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 32 });
        renderHeader();
        y = tableTop;
        renderTableHeader(y);
        y += rowHeight;
      }

      if (rowIndex % 2 === 0) {
        doc.rect(doc.page.margins.left, y, pageWidth, rowHeight).fill('#f9fafb');
      }

      doc.fillColor('#111827').font('Helvetica').fontSize(9).text(displayDateLabel(dateString), doc.page.margins.left + 6, y + 5, { width: dateColumnWidth - 12 });
      hotels.forEach((hotel, index) => {
        const x = doc.page.margins.left + dateColumnWidth + (index * hotelColumnWidth);
        const hotelRow = hotel.rows.find((row) => row.stayDate === dateString);
        const occupancyText = `${Number(hotelRow?.occupancy || 0).toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
        doc.text(occupancyText, x + 6, y + 5, { width: hotelColumnWidth - 12, align: 'right' });
      });
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

  const startDate = startOfTodayUtc();
  const endDate = addDays(startDate, REPORT_WINDOW_DAYS - 1);
  const hotels = await Promise.all(hotelUids.map((hotelUid) => getOccupancyRowsForRange(hotelUid, startDate, endDate)));
  const pdfBuffer = await buildPdfBuffer({ startDate, endDate, hotels });
  const resend = new Resend(resendApiKey);

  const subject = `Occupancy overzicht ${displayDateLabel(startDate)} - ${displayDateLabel(endDate)}`;
  const hotelNames = hotels.map((hotel) => hotel.hotelName).join(', ');

  const response = await resend.emails.send({
    from: resendFrom,
    to,
    subject,
    text: `In de bijlage vind je het occupancy overzicht voor de komende ${REPORT_WINDOW_DAYS} dagen voor: ${hotelNames}.\n\nVerstuurd via ${reason}${triggerId ? ` (trigger: ${triggerId})` : ''}.`,
    attachments: [
      {
        filename: `occupancy-overzicht-${startDate}-tot-${endDate}.pdf`,
        content: pdfBuffer.toString('base64'),
      },
    ],
  });

  await db.collection('scheduledMails').doc('scheduledOccupancyMail').set({
    lastSentAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSentReason: reason,
    lastTriggerId: triggerId || null,
    lastMailId: response?.data?.id || null,
    lastSentTo: to,
    lastHotelUid: hotelUids,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  logger.info('Occupancy mail sent', { reason, triggerId, hotelCount: hotelUids.length, toCount: to.length });
  return response;
}

const sendScheduledOccupancyMail = onSchedule({ schedule: '0 6 * * *', timeZone: DEFAULT_TIMEZONE, secrets: [RESEND_API_KEY, RESEND_FROM] }, async () => {
  const scheduleSnap = await db.doc(SCHEDULED_MAIL_DOC_PATH).get();
  if (!scheduleSnap.exists) {
    logger.warn('scheduledOccupancyMail config not found; skipping scheduled send');
    return;
  }

  await sendOccupancyMail({ scheduleConfig: scheduleSnap.data() || {}, reason: 'scheduled' });
});

const runScheduledOccupancyMailNow = onDocumentCreated({ document: `${SCHEDULED_MAIL_DOC_PATH}/${MANUAL_TRIGGER_COLLECTION}/{triggerId}`, secrets: [RESEND_API_KEY, RESEND_FROM] }, async (event) => {
  const triggerId = event.params.triggerId;
  const triggerRef = event.data.ref;
  const triggerData = event.data.data() || {};

  try {
    await triggerRef.set({ status: 'processing', startedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    const scheduleSnap = await db.doc(SCHEDULED_MAIL_DOC_PATH).get();
    if (!scheduleSnap.exists) throw new Error('scheduledOccupancyMail config not found');

    await sendOccupancyMail({ scheduleConfig: scheduleSnap.data() || {}, reason: 'manual', triggerId });
    await triggerRef.set({ status: 'completed', completedAt: admin.firestore.FieldValue.serverTimestamp(), requestedBy: triggerData.requestedBy || null }, { merge: true });
  } catch (error) {
    logger.error('Manual occupancy mail trigger failed', { triggerId, message: error?.message || String(error) });
    await triggerRef.set({ status: 'failed', failedAt: admin.firestore.FieldValue.serverTimestamp(), error: error?.message || String(error) }, { merge: true });
    throw error;
  }
});

module.exports = { sendScheduledOccupancyMail, runScheduledOccupancyMailNow };
