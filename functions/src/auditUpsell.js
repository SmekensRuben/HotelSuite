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

function findMatchingPackageCode(actionDescription, packageCodes) {
  const upperActions = actionDescription.map((item) => item.toUpperCase());
  return packageCodes.find((packageCode) => {
    const upperPackageCode = packageCode.toUpperCase();
    return upperActions.some((item) => item.includes(upperPackageCode));
  }) || null;
}

function parseOperaDate(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return null;

  const [, day, month, year] = match;
  const monthNumber = MONTHS[month.toLowerCase()];
  if (!monthNumber) return null;

  return `${year}-${monthNumber}-${String(day).padStart(2, '0')}`;
}

function parseUpsellAuditRecord(auditRecord, packageCodes) {
  const actionDescription = normalizeActionDescription(auditRecord.actionDescription);
  const packageCode = findMatchingPackageCode(actionDescription, packageCodes);
  if (!packageCode) return null;

  const escapedPackageCode = packageCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const productAddedRegex = new RegExp(`^PRODUCT\\s+(${escapedPackageCode})\\s+ADDED$`, 'i');
  const productPriceRegex = new RegExp(
    `^PRODUCT\\s+(${escapedPackageCode})\\s+BETWEEN\\s+(\\d{1,2}-[A-Za-z]{3}-\\d{4})\\s+AND\\s+(\\d{1,2}-[A-Za-z]{3}-\\d{4})\\s*:\\s*PRICE\\s*->\\s*(.*?)(?:\\s+Confirmation No\\.\\s*(.+))?$`,
    'i'
  );

  const productAddedItem = actionDescription.find((item) => productAddedRegex.test(item));
  if (!productAddedItem) return null;

  const productPriceItem = actionDescription.find((item) => productPriceRegex.test(item));
  const productPriceMatch = productPriceItem?.match(productPriceRegex);
  if (!productPriceMatch) return null;

  const confirmationItem = actionDescription.find((item) => /^Confirmation No\.\s*(.+)$/i.test(item));
  const confirmationMatch = confirmationItem?.match(/^Confirmation No\.\s*(.+)$/i);
  const confirmationNumber = productPriceMatch[5]?.trim() || confirmationMatch?.[1]?.trim();
  if (!confirmationNumber) return null;

  return {
    logDate: auditRecord.logDate || null,
    logTime: auditRecord.logTime || null,
    operaUser: auditRecord.operaUser || null,
    packageCode: productPriceMatch[1],
    startDate: parseOperaDate(productPriceMatch[2]),
    endDate: parseOperaDate(productPriceMatch[3]),
    price: productPriceMatch[4].trim(),
    confirmationNumber,
  };
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
      const auditUpsellRecord = parseUpsellAuditRecord(auditDoc.data() || {}, packageCodes);
      if (!auditUpsellRecord) continue;

      const targetDate = auditUpsellRecord.logDate || dateKey;
      const targetRef = db.doc(`hotels/${hotelUid}/upselling/auditUpsell/${targetDate}/${auditDoc.id}`);
      batch.set(
        targetRef,
        {
          ...auditUpsellRecord,
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
  getYesterdayDateKey,
};
