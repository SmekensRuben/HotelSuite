const { onSchedule, logger, admin } = require('./config');

const db = admin.firestore();
const DEFAULT_TIMEZONE = 'Europe/Amsterdam';
const REPORT_LOOKBACK_DAYS = 31;
const AUDIT_UPSELL_JOB_TIMEOUT_SECONDS = 900;
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


function shiftDateKey(dateKey, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return null;

  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getReportLookbackStartDateKey(maxDateKey, lookbackDays = REPORT_LOOKBACK_DAYS) {
  return shiftDateKey(maxDateKey, -(Math.max(1, lookbackDays) - 1));
}

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
  return Array.from(new Set(value.map((item) => String(item?.packageCode || item?.id || item || '').trim()).filter(Boolean)));
}

async function getUpsellPackageCodes(hotelUid) {
  const packageCodesSnap = await db.collection(`hotels/${hotelUid}/settings/upsells/packagecodes`).get();
  return normalizePackageCodes(
    packageCodesSnap.docs.map((packageCodeDoc) => ({
      id: packageCodeDoc.id,
      ...(packageCodeDoc.data() || {}),
    }))
  );
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
    const productConfirmationRegex = new RegExp(
      `^PRODUCT\\s+${escapedPackageCode}\\s+BETWEEN\\s+\\d{1,2}-[A-Za-z]{3}-\\d{4}\\s+AND\\s+\\d{1,2}-[A-Za-z]{3}-\\d{4}\\s*:\\s*Confirmation No\\.\\s*(.+)$`,
      'i'
    );

    const productAddedItem = actionDescription.find((item) => productAddedRegex.test(item));
    if (!productAddedItem) return [];
    const packageConfirmationItem = actionDescription.find((item) => productConfirmationRegex.test(item));
    const packageConfirmationMatch = packageConfirmationItem?.match(productConfirmationRegex);

    return actionDescription.flatMap((item) => {
      const productPriceMatch = item.match(productPriceRegex);
      if (!productPriceMatch) return [];

      const confirmationNumber = productPriceMatch[5]?.trim()
        || packageConfirmationMatch?.[1]?.trim()
        || confirmationMatch?.[1]?.trim();
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

function getTodayDateKey(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}


const BILL_LINKABLE_AUDIT_UPSELL_STATUSES = new Set(['Arrived', 'Created', 'Pending']);

function getDateCollectionsDescending(collectionRefs, minDateKey = null, maxDateKey = null) {
  return collectionRefs
    .filter((collectionRef) => /^\d{4}-\d{2}-\d{2}$/.test(collectionRef.id))
    .filter((collectionRef) => !minDateKey || collectionRef.id >= minDateKey)
    .filter((collectionRef) => !maxDateKey || collectionRef.id <= maxDateKey)
    .sort((a, b) => b.id.localeCompare(a.id));
}

function getReservationBillNumbers(reservationBill, documentId) {
  const candidates = [
    reservationBill.billNumber,
    reservationBill.billNo,
    reservationBill.billId,
    reservationBill.folioNumber,
    reservationBill.folioNo,
    reservationBill.folioId,
    reservationBill.billNumbers,
  ];

  const billNumbers = candidates.flatMap((candidate) => (Array.isArray(candidate) ? candidate : [candidate]));
  const normalizedBillNumbers = normalizeBillNumbers(billNumbers);
  return normalizedBillNumbers.length ? normalizedBillNumbers : normalizeBillNumbers([documentId]);
}

async function getLinkableAuditUpsellSnapshotMap(hotelUid, minDateKey = null, maxDateKey = null) {
  const auditUpsellRootRef = db.doc(`hotels/${hotelUid}/upselling/auditUpsell`);
  const dateCollections = getDateCollectionsDescending(
    await auditUpsellRootRef.listCollections(),
    minDateKey,
    maxDateKey
  );
  const linkableAuditUpsellSnapshotMap = new Map();

  for (const dateCollection of dateCollections) {
    const auditUpsellsSnap = await dateCollection.get();

    for (const auditUpsellSnap of auditUpsellsSnap.docs) {
      if (linkableAuditUpsellSnapshotMap.has(auditUpsellSnap.id)) continue;

      const auditUpsell = auditUpsellSnap.data() || {};
      if (!BILL_LINKABLE_AUDIT_UPSELL_STATUSES.has(auditUpsell.status)) continue;

      linkableAuditUpsellSnapshotMap.set(auditUpsellSnap.id, auditUpsellSnap);
    }
  }

  return linkableAuditUpsellSnapshotMap;
}

async function findLinkableAuditUpsellSnapshot(hotelUid, auditUpsellDocumentId) {
  const linkableAuditUpsellSnapshotMap = await getLinkableAuditUpsellSnapshotMap(hotelUid);
  return linkableAuditUpsellSnapshotMap.get(auditUpsellDocumentId) || null;
}

async function linkReservationBillsForHotel(hotelUid, maxDateKey = getTodayDateKey()) {
  const reservationBillsRootRef = db.doc(`hotels/${hotelUid}/reports/reservationbills`);
  const minDateKey = getReportLookbackStartDateKey(maxDateKey);
  const reservationBillsDateCollections = getDateCollectionsDescending(
    await reservationBillsRootRef.listCollections(),
    minDateKey,
    maxDateKey
  );
  let checkedReservationBills = 0;
  let linkedReservationBills = 0;
  let batch = db.batch();
  let writesInBatch = 0;
  const linkableAuditUpsellSnapshotMap = await getLinkableAuditUpsellSnapshotMap(hotelUid);

  for (const reservationBillsDateCollection of reservationBillsDateCollections) {
    const reservationBillsSnap = await reservationBillsDateCollection.get();

    for (const reservationBillSnap of reservationBillsSnap.docs) {
      const reservationBill = reservationBillSnap.data() || {};
      const confirmationNumber = String(reservationBill.confirmationNumber || '').trim();
      if (!confirmationNumber) continue;

      checkedReservationBills += 1;
      const auditUpsellSnap = linkableAuditUpsellSnapshotMap.get(confirmationNumber);
      if (!auditUpsellSnap) continue;

      const billNumbers = getReservationBillNumbers(reservationBill, reservationBillSnap.id);
      if (!billNumbers.length) continue;

      batch.set(
        auditUpsellSnap.ref,
        {
          billNumbers: admin.firestore.FieldValue.arrayUnion(...billNumbers),
          reservationBillLinkStatus: 'linked',
          reservationBillLinkedAt: admin.firestore.FieldValue.serverTimestamp(),
          sourceReservationBillsDates: admin.firestore.FieldValue.arrayUnion(reservationBillsDateCollection.id),
        },
        { merge: true }
      );
      writesInBatch += 1;
      linkedReservationBills += 1;

      if (writesInBatch >= 450) {
        await batch.commit();
        batch = db.batch();
        writesInBatch = 0;
      }
    }
  }

  if (writesInBatch > 0) await batch.commit();

  return {
    reservationBillsDates: reservationBillsDateCollections.map((collectionRef) => collectionRef.id),
    checkedReservationBills,
    linkedReservationBills,
  };
}

function normalizeBillNumbers(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)));
}

function getDetailedFolioSearchDateKeys(auditUpsellRecord, todayDateKey = getTodayDateKey()) {
  const startDate = auditUpsellRecord.packageStartDate || auditUpsellRecord.startDate;
  return enumerateStayDateKeys(startDate, todayDateKey);
}

function normalizeDetailedFolioTransactions(transactions) {
  if (!Array.isArray(transactions)) return [];

  return transactions.map((transaction) => ({
    credit: transaction?.credit ?? 0,
    debit: transaction?.debit ?? 0,
    description: transaction?.description || '',
    transactionCode: transaction?.transactionCode || '',
    transactionDate: transaction?.transactionDate || '',
    transactionNumber: transaction?.transactionNumber || '',
  }));
}

async function findDetailedFolioForBillNumber(hotelUid, billNumber, dateKeys) {
  for (const dateKey of dateKeys) {
    const detailedFolioSnap = await db
      .doc(`hotels/${hotelUid}/reports/detailedfolio/${dateKey}/${billNumber}`)
      .get();

    if (!detailedFolioSnap.exists) continue;

    const detailedFolio = detailedFolioSnap.data() || {};
    return {
      billNumber,
      roomNumber: detailedFolio.roomNumber || null,
      transactions: normalizeDetailedFolioTransactions(detailedFolio.transactions),
    };
  }

  return null;
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
      arrivalDate: reservationDetails.arrivalDate || null,
      departureDate: reservationDetails.departureDate || null,
      reservationDetailsDate: dateKey,
    };
  }

  return null;
}

async function getPendingAuditUpsellSnapshots(hotelUid) {
  const auditUpsellRootRef = db.doc(`hotels/${hotelUid}/upselling/auditUpsell`);
  const dateCollections = await auditUpsellRootRef.listCollections();
  const pendingSnapshots = [];

  for (const dateCollection of dateCollections) {
    const auditUpsellsSnap = await dateCollection.get();
    for (const auditUpsellSnap of auditUpsellsSnap.docs) {
      const auditUpsell = auditUpsellSnap.data() || {};
      const billNumbers = normalizeBillNumbers(auditUpsell.billNumbers);
      const detailedFolios = Array.isArray(auditUpsell.detailedFolios) ? auditUpsell.detailedFolios : [];
      const linkedBillNumbers = new Set(
        detailedFolios.map((folio) => String(folio?.billNumber || '').trim()).filter(Boolean)
      );
      const hasUnlinkedBillNumbers = billNumbers.some((billNumber) => !linkedBillNumbers.has(billNumber));

      if (auditUpsell.folioLinkStatus === 'linked' && !hasUnlinkedBillNumbers) continue;
      pendingSnapshots.push(auditUpsellSnap);
    }
  }

  return pendingSnapshots;
}

async function linkDetailedFoliosForHotel(hotelUid, todayDateKey = getTodayDateKey()) {
  const pendingAuditUpsellSnaps = await getPendingAuditUpsellSnapshots(hotelUid);
  let checkedRecords = 0;
  let linkedRecords = 0;
  let linkedFolios = 0;
  let batch = db.batch();
  let writesInBatch = 0;

  for (const auditUpsellSnap of pendingAuditUpsellSnaps) {
    const auditUpsellRecord = auditUpsellSnap.data() || {};
    const billNumbers = normalizeBillNumbers(auditUpsellRecord.billNumbers);
    if (!billNumbers.length) continue;

    checkedRecords += 1;
    const existingDetailedFolios = Array.isArray(auditUpsellRecord.detailedFolios)
      ? auditUpsellRecord.detailedFolios
      : [];
    const existingBillNumbers = new Set(
      existingDetailedFolios.map((folio) => String(folio?.billNumber || '').trim()).filter(Boolean)
    );
    const dateKeys = getDetailedFolioSearchDateKeys(auditUpsellRecord, todayDateKey);
    const newDetailedFolios = [];

    for (const billNumber of billNumbers) {
      if (existingBillNumbers.has(billNumber)) continue;

      const detailedFolio = await findDetailedFolioForBillNumber(hotelUid, billNumber, dateKeys);
      if (!detailedFolio) continue;

      existingBillNumbers.add(billNumber);
      newDetailedFolios.push(detailedFolio);
    }

    const hasLinkedFolios = existingDetailedFolios.length > 0 || newDetailedFolios.length > 0;
    const updateData = hasLinkedFolios
      ? {
          detailedFolios: [...existingDetailedFolios, ...newDetailedFolios],
          folioLinkStatus: 'linked',
          folioLinkedAt: admin.firestore.FieldValue.serverTimestamp(),
        }
      : {
          folioLinkStatus: 'pending',
          lastFolioLinkAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
        };

    batch.set(auditUpsellSnap.ref, updateData, { merge: true });
    writesInBatch += 1;
    if (hasLinkedFolios) linkedRecords += 1;
    linkedFolios += newDetailedFolios.length;

    if (writesInBatch >= 450) {
      await batch.commit();
      batch = db.batch();
      writesInBatch = 0;
    }
  }

  if (writesInBatch > 0) await batch.commit();

  return { checkedRecords, linkedRecords, linkedFolios };
}


function getAudittrailProcessedDatesCollection(hotelUid) {
  return db.collection(`hotels/${hotelUid}/upselling/auditUpsell/processedAudittrailDates`);
}

async function getProcessedAudittrailDateKeys(hotelUid, dateKeys) {
  if (!dateKeys.length) return new Set();

  const processedDateRefs = dateKeys.map((dateKey) => getAudittrailProcessedDatesCollection(hotelUid).doc(dateKey));
  const processedDateSnaps = await db.getAll(...processedDateRefs);
  return new Set(processedDateSnaps.filter((dateSnap) => dateSnap.exists).map((dateSnap) => dateSnap.id));
}

async function getAudittrailDateCollectionsToProcess(hotelUid, maxDateKey = getYesterdayDateKey()) {
  const audittrailRootRef = db.doc(`hotels/${hotelUid}/reports/audittrail`);
  const minDateKey = getReportLookbackStartDateKey(maxDateKey);
  const audittrailDateCollections = getDateCollectionsDescending(
    await audittrailRootRef.listCollections(),
    minDateKey,
    maxDateKey
  );
  const processedDateKeys = await getProcessedAudittrailDateKeys(
    hotelUid,
    audittrailDateCollections.map((dateCollection) => dateCollection.id)
  );

  return audittrailDateCollections.filter((dateCollection) => !processedDateKeys.has(dateCollection.id));
}

async function processAuditUpsellsForDate(dateKey = getYesterdayDateKey()) {
  const hotelsSnap = await db.collection('hotels').get();
  let processedHotels = 0;
  let createdRecords = 0;

  for (const hotelDoc of hotelsSnap.docs) {
    const hotelUid = hotelDoc.id;
    const packageCodes = await getUpsellPackageCodes(hotelUid);

    if (packageCodes.length) {
      processedHotels += 1;
      const audittrailDateCollections = await getAudittrailDateCollectionsToProcess(hotelUid, dateKey);

      for (const audittrailDateCollection of audittrailDateCollections) {
        const audittrailDateKey = audittrailDateCollection.id;
        const audittrailSnap = await audittrailDateCollection.get();
        let batch = db.batch();
        let writesInBatch = 0;

        for (const auditDoc of audittrailSnap.docs) {
          const auditUpsellRecords = parseUpsellAuditRecords(auditDoc.data() || {}, packageCodes);
          if (!auditUpsellRecords.length) continue;

          for (const auditUpsellRecord of auditUpsellRecords) {
            const targetDate = auditUpsellRecord.logDate || audittrailDateKey;
            const targetDocumentId = auditUpsellRecord.confirmationNumber;
            const reservationDetails = await findReservationDetailsForUpsell(hotelUid, auditUpsellRecord);
            const targetRef = db.doc(`hotels/${hotelUid}/upselling/auditUpsell/${targetDate}/${targetDocumentId}`);
            batch.set(
              targetRef,
              {
                ...auditUpsellRecord,
                ...(reservationDetails || {}),
                status: reservationDetails ? 'Arrived' : 'Created',
                sourceAudittrailDate: audittrailDateKey,
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

        batch.set(
          getAudittrailProcessedDatesCollection(hotelUid).doc(audittrailDateKey),
          {
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
            recordsScanned: audittrailSnap.size,
          },
          { merge: true }
        );
        writesInBatch += 1;

        if (writesInBatch > 0) await batch.commit();
      }
    }

    const reservationBillLinkResult = await linkReservationBillsForHotel(hotelUid);
    logger.info('Audit upsell reservation bill linking completed', {
      hotelUid,
      ...reservationBillLinkResult,
    });

    const folioLinkResult = await linkDetailedFoliosForHotel(hotelUid);
    logger.info('Audit upsell detailed folio linking completed', {
      hotelUid,
      ...folioLinkResult,
    });
  }

  logger.info('Audit upsell job completed', { dateKey, processedHotels, createdRecords });
  return { dateKey, processedHotels, createdRecords };
}

const processScheduledAuditUpsells = onSchedule(
  {
    schedule: '30 7 * * *',
    timeZone: DEFAULT_TIMEZONE,
    timeoutSeconds: AUDIT_UPSELL_JOB_TIMEOUT_SECONDS,
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
  getLinkableAuditUpsellSnapshotMap,
  findDetailedFolioForBillNumber,
  linkReservationBillsForHotel,
  linkDetailedFoliosForHotel,
  enumerateStayDateKeys,
  getDetailedFolioSearchDateKeys,
  getTodayDateKey,
  getYesterdayDateKey,
  getReportLookbackStartDateKey,
  getAudittrailDateCollectionsToProcess,
};
