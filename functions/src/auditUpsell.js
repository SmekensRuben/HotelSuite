const { onSchedule, logger, admin } = require('./config');

const db = admin.firestore();
const DEFAULT_TIMEZONE = 'Europe/Amsterdam';
const MONTHS = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

function getYesterdayDateKey(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayInTimezone = formatter.format(now);
  const [year, month, day] = todayInTimezone.split('-').map(Number);
  const yesterdayUtc = new Date(Date.UTC(year, month - 1, day - 1));
  return yesterdayUtc.toISOString().slice(0, 10);
}

function normalizePackageCodes(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)));
}

function normalizeActionDescription(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}


function parseOperaDate(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return null;

  const [, day, month, year] = match;
  const monthNumber = MONTHS[month.toLowerCase()];
  if (!monthNumber) return null;

  return `${year}-${monthNumber}-${String(day).padStart(2, '0')}`;
}

function parseUpsellAuditRecords(auditRecord, packageCodes) {
  const actionDescription = normalizeActionDescription(auditRecord.actionDescription);
  const confirmationItem = actionDescription.find((item) => /^Confirmation No\.\s*(.+)$/i.test(item));
  const confirmationMatch = confirmationItem?.match(/^Confirmation No\.\s*(.+)$/i);

  return packageCodes.flatMap((packageCode) => {
    const escapedPackageCode = packageCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const productAddedRegex = new RegExp(`^PRODUCT\\s+(${escapedPackageCode})\\s+ADDED$`, 'i');
    const productPriceRegex = new RegExp(
      `^PRODUCT\\s+(${escapedPackageCode})\\s+BETWEEN\\s+(\\d{1,2}-[A-Za-z]{3}-\\d{4})\\s+AND\\s+(\\d{1,2}-[A-Za-z]{3}-\\d{4})\\s*:\\s*PRICE\\s*->\\s*(.*?)(?:\\s+Confirmation No\\.\\s*(.+))?$`,
      'i'
    );

    const productAddedItem = actionDescription.find((item) => productAddedRegex.test(item));
    if (!productAddedItem) return [];

    return actionDescription.flatMap((item) => {
      const productPriceMatch = item.match(productPriceRegex);
      if (!productPriceMatch) return [];

      const confirmationNumber = productPriceMatch[5]?.trim() || confirmationMatch?.[1]?.trim();
      if (!confirmationNumber) return [];

      return [
        {
          logDate: auditRecord.logDate || null,
          logTime: auditRecord.logTime || null,
          operaUser: auditRecord.operaUser || null,
          packageCode: productPriceMatch[1],
          startDate: parseOperaDate(productPriceMatch[2]),
          endDate: parseOperaDate(productPriceMatch[3]),
          price: productPriceMatch[4].trim(),
          confirmationNumber,
        },
      ];
    });
  });
}

function parseUpsellAuditRecord(auditRecord, packageCodes) {
  return parseUpsellAuditRecords(auditRecord, packageCodes)[0] || null;
}

function enumerateStayDateKeys(startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(endDate || ''))) return [];

  const current = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(current.getTime()) || Number.isNaN(end.getTime())) return [];

  const dateKeys = [];
  while (current <= end) {
    dateKeys.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dateKeys;
}

async function findReservationDetailsForUpsell(hotelUid, auditUpsellRecord) {
  const confirmationNumber = String(auditUpsellRecord.confirmationNumber || '').trim();
  if (!confirmationNumber) return null;

  for (const dateKey of enumerateStayDateKeys(auditUpsellRecord.startDate, auditUpsellRecord.endDate)) {
    const reservationDetailsSnap = await db
      .doc(`hotels/${hotelUid}/reports/reservationdetails/${dateKey}/${confirmationNumber}`)
      .get();

    if (!reservationDetailsSnap.exists) continue;

    const reservationDetails = reservationDetailsSnap.data() || {};
    return {
      fullName: reservationDetails.fullName || null,
      rateCode: reservationDetails.rateCode || null,
      roomNumber: reservationDetails.roomNumber || null,
      reservationDetailsDate: dateKey,
    };
  }

  return null;
}

async function processAuditUpsellsForDate(dateKey = getYesterdayDateKey()) {
  const hotelsSnap = await db.collection('hotels').get();
  let processedHotels = 0;
  let createdRecords = 0;

  for (const hotelDoc of hotelsSnap.docs) {
    const hotelUid = hotelDoc.id;
    const upsellSettingsSnap = await db.doc(`hotels/${hotelUid}/settings/upsells`).get();
    const packageCodes = normalizePackageCodes(upsellSettingsSnap.data()?.packageCodes);

    if (!packageCodes.length) continue;

    processedHotels += 1;
    const audittrailSnap = await db
      .collection(`hotels/${hotelUid}/reports/audittrail/${dateKey}`)
      .get();

    let batch = db.batch();
    let writesInBatch = 0;

    for (const auditDoc of audittrailSnap.docs) {
      const auditUpsellRecords = parseUpsellAuditRecords(auditDoc.data() || {}, packageCodes);
      if (!auditUpsellRecords.length) continue;

      for (const auditUpsellRecord of auditUpsellRecords) {
        const targetDate = auditUpsellRecord.logDate || dateKey;
        const targetDocumentId = auditUpsellRecord.confirmationNumber;
        const reservationDetails = await findReservationDetailsForUpsell(hotelUid, auditUpsellRecord);
        const targetRef = db.doc(`hotels/${hotelUid}/upselling/auditUpsell/${targetDate}/${targetDocumentId}`);
        batch.set(
          targetRef,
          {
            ...auditUpsellRecord,
            ...(reservationDetails || {}),
            sourceAudittrailDate: dateKey,
            sourceAudittrailDocumentId: auditDoc.id,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        writesInBatch += 1;
        createdRecords += 1;

        if (writesInBatch >= 450) {
          await batch.commit();
          batch = db.batch();
          writesInBatch = 0;
        }
      }
    }

    if (writesInBatch > 0) await batch.commit();
  }

  logger.info('Audit upsell job completed', { dateKey, processedHotels, createdRecords });
  return { dateKey, processedHotels, createdRecords };
}

const processScheduledAuditUpsells = onSchedule(
  {
    schedule: '30 7 * * *',
    timeZone: DEFAULT_TIMEZONE,
  },
  async () => {
    await processAuditUpsellsForDate();
  }
);

module.exports = {
  processScheduledAuditUpsells,
  processAuditUpsellsForDate,
  parseUpsellAuditRecord,
  parseUpsellAuditRecords,
  findReservationDetailsForUpsell,
  enumerateStayDateKeys,
  getYesterdayDateKey,
};
