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

function getTodayDateKey(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}


const BILL_LINKABLE_AUDIT_UPSELL_STATUSES = new Set(['Arrived', 'Created', 'Pending']);

function getLatestDateCollection(collectionRefs) {
  return collectionRefs
    .filter((collectionRef) => /^\d{4}-\d{2}-\d{2}$/.test(collectionRef.id))
    .sort((a, b) => b.id.localeCompare(a.id))[0] || null;
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

async function findLinkableAuditUpsellSnapshot(hotelUid, auditUpsellDocumentId) {
  const auditUpsellRootRef = db.doc(`hotels/${hotelUid}/upselling/auditUpsell`);
  const dateCollections = await auditUpsellRootRef.listCollections();

  for (const dateCollection of dateCollections) {
    const auditUpsellSnap = await dateCollection.doc(auditUpsellDocumentId).get();
    if (!auditUpsellSnap.exists) continue;

    const auditUpsell = auditUpsellSnap.data() || {};
    if (!BILL_LINKABLE_AUDIT_UPSELL_STATUSES.has(auditUpsell.status)) continue;

    return auditUpsellSnap;
  }

  return null;
}

async function linkLatestReservationBillsForHotel(hotelUid) {
  const reservationBillsRootRef = db.doc(`hotels/${hotelUid}/reports/reservationbills`);
  const latestReservationBillsCollection = getLatestDateCollection(await reservationBillsRootRef.listCollections());

  if (!latestReservationBillsCollection) {
    return { latestReservationBillsDate: null, checkedReservationBills: 0, linkedReservationBills: 0 };
  }

  const reservationBillsSnap = await latestReservationBillsCollection.get();
  let checkedReservationBills = 0;
  let linkedReservationBills = 0;
  let batch = db.batch();
  let writesInBatch = 0;

  for (const reservationBillSnap of reservationBillsSnap.docs) {
    const reservationBill = reservationBillSnap.data() || {};
    const confirmationNumber = String(reservationBill.confirmationNumber || '').trim();
    if (!confirmationNumber) continue;

    checkedReservationBills += 1;
    const auditUpsellSnap = await findLinkableAuditUpsellSnapshot(hotelUid, confirmationNumber);
    if (!auditUpsellSnap) continue;

    const billNumbers = getReservationBillNumbers(reservationBill, reservationBillSnap.id);
    if (!billNumbers.length) continue;

    batch.set(
      auditUpsellSnap.ref,
      {
        billNumbers: admin.firestore.FieldValue.arrayUnion(...billNumbers),
        reservationBillLinkStatus: 'linked',
        reservationBillLinkedAt: admin.firestore.FieldValue.serverTimestamp(),
        sourceReservationBillsDate: latestReservationBillsCollection.id,
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

  if (writesInBatch > 0) await batch.commit();

  return {
    latestReservationBillsDate: latestReservationBillsCollection.id,
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
      if ((auditUpsellSnap.data() || {}).folioLinkStatus === 'linked') continue;
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

async function processAuditUpsellsForDate(dateKey = getYesterdayDateKey()) {
  const hotelsSnap = await db.collection('hotels').get();
  let processedHotels = 0;
  let createdRecords = 0;

  for (const hotelDoc of hotelsSnap.docs) {
    const hotelUid = hotelDoc.id;
    const upsellSettingsSnap = await db.doc(`hotels/${hotelUid}/settings/upsells`).get();
    const packageCodes = normalizePackageCodes(upsellSettingsSnap.data()?.packageCodes);

    if (packageCodes.length) {
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
              status: reservationDetails ? 'Arrived' : 'Created',
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

    const reservationBillLinkResult = await linkLatestReservationBillsForHotel(hotelUid);
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
  findDetailedFolioForBillNumber,
  linkLatestReservationBillsForHotel,
  linkDetailedFoliosForHotel,
  enumerateStayDateKeys,
  getDetailedFolioSearchDateKeys,
  getTodayDateKey,
  getYesterdayDateKey,
};
