import { db, collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc, serverTimestamp } from "../firebaseConfig";

const UPSELL_SETTINGS_DOC_ID = "upsells";

function normalizePackageCode(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizePackageCodeDocument(packageCode, documentId = "") {
  const code = normalizePackageCode(packageCode?.packageCode || packageCode?.id || documentId);
  if (!code) return null;

  return {
    id: documentId || code,
    packageCode: code,
    category: String(packageCode?.category || "").trim(),
    description: String(packageCode?.description || "").trim(),
  };
}

function normalizePackageCodes(packageCodes) {
  if (!Array.isArray(packageCodes)) return [];

  return packageCodes
    .map((packageCode) => normalizePackageCodeDocument(packageCode))
    .filter(Boolean)
    .sort((a, b) => a.packageCode.localeCompare(b.packageCode));
}

function normalizeDateKey(dateKey) {
  return String(dateKey || "").trim();
}

function parseDateKey(dateKey) {
  const normalized = normalizeDateKey(dateKey);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;

  const [year, month, day] = normalized.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function addDaysToDateKey(dateKey, days) {
  const date = parseDateKey(dateKey);
  if (!date) return dateKey;
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function enumerateDateKeys(startDate, endDate) {
  const start = parseDateKey(startDate);
  const end = parseDateKey(endDate);
  if (!start || !end || start > end) return [];

  const dateKeys = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    dateKeys.push(toDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dateKeys;
}


function toNonNegativeNumber(value) {
  if (value === "" || value === null || value === undefined) return 0;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : 0;
}

function normalizeDailyExpectedOccupancy(dailyExpectedOccupancy, legacyDailyRevenueTargets = {}) {
  const source = dailyExpectedOccupancy && typeof dailyExpectedOccupancy === "object"
    ? dailyExpectedOccupancy
    : Object.entries(legacyDailyRevenueTargets || {}).reduce((accumulator, [dateKey, target]) => {
        accumulator[dateKey] = target?.expectedOccupancy;
        return accumulator;
      }, {});

  if (!source || typeof source !== "object") return {};

  return Object.entries(source).reduce((accumulator, [dateKey, occupancy]) => {
    const normalizedDateKey = normalizeDateKey(dateKey);
    if (!parseDateKey(normalizedDateKey)) return accumulator;
    accumulator[normalizedDateKey] = toNonNegativeNumber(occupancy);
    return accumulator;
  }, {});
}

function normalizeRevenueTargetRules(revenueTargetRules, legacyDailyRevenueTargets = {}) {
  const rules = Array.isArray(revenueTargetRules)
    ? revenueTargetRules
    : Object.entries(legacyDailyRevenueTargets || {}).map(([dateKey, target]) => ({
        startDate: dateKey,
        endDate: dateKey,
        minimumTargetRevenuePerOccupiedRoom: target?.minimumRevenuePerOccupiedRoom,
        reachTargetRevenuePerOccupiedRoom: target?.reachRevenuePerOccupiedRoom,
        stretchTargetRevenuePerOccupiedRoom: target?.stretchRevenuePerOccupiedRoom,
      }));

  return rules
    .map((rule, index) => {
      const startDate = normalizeDateKey(rule?.startDate);
      const endDate = normalizeDateKey(rule?.endDate);
      if (!parseDateKey(startDate) || !parseDateKey(endDate) || startDate > endDate) return null;

      return {
        id: String(rule?.id || `${startDate}-${endDate}-${index}`),
        startDate,
        endDate,
        minimumTargetRevenuePerOccupiedRoom: toNonNegativeNumber(rule?.minimumTargetRevenuePerOccupiedRoom),
        reachTargetRevenuePerOccupiedRoom: toNonNegativeNumber(rule?.reachTargetRevenuePerOccupiedRoom),
        stretchTargetRevenuePerOccupiedRoom: toNonNegativeNumber(rule?.stretchTargetRevenuePerOccupiedRoom),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate));
}

function formatFirestoreValue(value) {
  if (value?.toDate) return toDateKey(value.toDate());
  return value ?? "";
}

function sanitizeDocumentId(value) {
  return String(value || "")
    .trim()
    .replace(/[\/#?%&{}<>*+$!'":@`|=]/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeAuditUpsellPackage(packageRecord, index) {
  return {
    packageCode: normalizePackageCode(packageRecord?.packageCode),
    startDate: normalizeDateKey(packageRecord?.startDate),
    endDate: normalizeDateKey(packageRecord?.endDate),
    price: String(packageRecord?.price ?? "").trim(),
    source: "manual",
    manualPackageIndex: index,
  };
}

function getAuditUpsellPackages(data) {
  return Array.isArray(data.packages) ? data.packages : [];
}

function getAuditUpsellPackageCodes(data) {
  const packages = getAuditUpsellPackages(data);
  return Array.from(new Set(packages.map((packageRecord) => packageRecord?.packageCode).filter(Boolean)));
}

function getAuditUpsellDateRange(data, dateField) {
  const packageDates = getAuditUpsellPackages(data)
    .map((packageRecord) => formatFirestoreValue(packageRecord?.[dateField]))
    .filter(Boolean)
    .sort();

  if (!packageDates.length) return "";
  return dateField === "startDate" ? packageDates[0] : packageDates[packageDates.length - 1];
}

function getAuditUpsellPrice(data) {
  const packages = getAuditUpsellPackages(data);
  if (!packages.length) return "";

  const total = packages.reduce((sum, packageRecord) => {
    const numericPrice = Number.parseFloat(String(packageRecord?.price || "").replace(",", "."));
    return Number.isFinite(numericPrice) ? sum + numericPrice : sum;
  }, 0);

  return Number.isInteger(total) ? String(total) : total.toFixed(2);
}

function formatAuditUpsellData(data, auditUpsellDocId, dateKey) {
  const packageCodes = getAuditUpsellPackageCodes(data);

  return {
    ...data,
    id: `${dateKey}-${auditUpsellDocId}`,
    documentId: auditUpsellDocId,
    dateKey,
    logDate: formatFirestoreValue(data.logDate || dateKey),
    logTime: formatFirestoreValue(data.logTime),
    operaUser: data.operaUser || "",
    packageCodes,
    packageCode: packageCodes.join(", "),
    startDate: getAuditUpsellDateRange(data, "startDate"),
    endDate: getAuditUpsellDateRange(data, "endDate"),
    arrivalDate: formatFirestoreValue(data.arrivalDate),
    departureDate: formatFirestoreValue(data.departureDate),
    price: getAuditUpsellPrice(data),
    status: getUpsellStatus(data),
    confirmationNumber: data.confirmationNumber || auditUpsellDocId,
  };
}

function getDefaultUpsellStatus(data) {
  if (data.status) return data.status;
  return data.reservationDetailsDate || data.roomNumber || data.fullName || data.rateCode
    ? "Arrived"
    : "Pending";
}

function getUpsellStatus(data) {
  const validationStatus = String(data.validationStatus || "").toLowerCase();
  const folioLinkStatus = String(data.folioLinkStatus || "").toLowerCase();

  if (validationStatus === "approved") return "Validated";
  if (validationStatus === "rejected") return "Rejected";
  if (folioLinkStatus === "linked") return "Checked Out";
  return getDefaultUpsellStatus(data);
}

export async function getUpsellSettings(hotelUid) {
  if (!hotelUid) return { packageCodes: [], dailyExpectedOccupancy: {}, revenueTargetRules: [] };

  const settingsRef = doc(db, `hotels/${hotelUid}/settings`, UPSELL_SETTINGS_DOC_ID);
  const packageCodesRef = collection(db, `hotels/${hotelUid}/settings/${UPSELL_SETTINGS_DOC_ID}/packagecodes`);
  const [snapshot, packageCodesSnapshot] = await Promise.all([getDoc(settingsRef), getDocs(packageCodesRef)]);
  const data = snapshot.exists() ? snapshot.data() : {};

  return {
    ...data,
    packageCodes: normalizePackageCodes(packageCodesSnapshot.docs.map((packageCodeDoc) => normalizePackageCodeDocument(packageCodeDoc.data() || {}, packageCodeDoc.id))),
    dailyExpectedOccupancy: normalizeDailyExpectedOccupancy(data.dailyExpectedOccupancy, data.dailyRevenueTargets),
    revenueTargetRules: normalizeRevenueTargetRules(data.revenueTargetRules, data.dailyRevenueTargets),
  };
}

function getUpsellFilterDate(record) {
  return record.departureDate || record.endDate || "";
}

export async function getAuditUpsells(hotelUid, startDate, endDate, options = {}) {
  if (!hotelUid) return [];

  const filterByDepartureDate = options.dateFilter === "departureDate";
  const fetchStartDate = filterByDepartureDate ? addDaysToDateKey(startDate, -120) : startDate;
  const dateKeys = enumerateDateKeys(fetchStartDate, endDate);
  if (!dateKeys.length) return [];

  const snapshots = await Promise.all(
    dateKeys.map(async (dateKey) => {
      const auditUpsellsRef = collection(
        db,
        `hotels/${hotelUid}/upselling/auditUpsell/${dateKey}`
      );
      const snapshot = await getDocs(auditUpsellsRef);
      return { dateKey, docs: snapshot.docs };
    })
  );

  const records = snapshots.flatMap(({ dateKey, docs }) =>
    docs.map((auditUpsellDoc) => formatAuditUpsellData(auditUpsellDoc.data() || {}, auditUpsellDoc.id, dateKey))
  );

  if (!filterByDepartureDate) return records;

  return records.filter((record) => {
    const filterDate = getUpsellFilterDate(record);
    return filterDate >= startDate && filterDate <= endDate;
  });
}

export async function createAuditUpsell(hotelUid, auditUpsell) {
  if (!hotelUid) throw new Error("Hotel uid is required.");

  const dateKey = normalizeDateKey(auditUpsell?.logDate) || toDateKey(new Date());
  if (!parseDateKey(dateKey)) throw new Error("A valid log date is required.");

  const packages = Array.isArray(auditUpsell?.packages)
    ? auditUpsell.packages.map(normalizeAuditUpsellPackage).filter((packageRecord) => (
        packageRecord.packageCode
        && parseDateKey(packageRecord.startDate)
        && parseDateKey(packageRecord.endDate)
        && packageRecord.startDate <= packageRecord.endDate
      ))
    : [];

  if (!packages.length) throw new Error("At least one valid package is required.");

  const confirmationNumber = String(auditUpsell?.confirmationNumber || "").trim();
  const fallbackDocumentId = `manual-${Date.now()}`;
  const documentId = sanitizeDocumentId(confirmationNumber) || fallbackDocumentId;
  const auditUpsellRef = doc(db, `hotels/${hotelUid}/upselling/auditUpsell/${dateKey}/${documentId}`);

  const packageCodes = Array.from(new Set(packages.map((packageRecord) => packageRecord.packageCode)));
  const payload = {
    logDate: dateKey,
    logTime: String(auditUpsell?.logTime || "").trim(),
    operaUser: String(auditUpsell?.operaUser || "").trim(),
    confirmationNumber: confirmationNumber || documentId,
    status: String(auditUpsell?.status || "Created").trim() || "Created",
    fullName: String(auditUpsell?.fullName || "").trim(),
    roomNumber: String(auditUpsell?.roomNumber || "").trim(),
    arrivalDate: normalizeDateKey(auditUpsell?.arrivalDate),
    departureDate: normalizeDateKey(auditUpsell?.departureDate),
    rateCode: String(auditUpsell?.rateCode || "").trim(),
    packages,
    packageCodes,
    source: "manual",
    manuallyCreated: true,
    createdAt: serverTimestamp(),
    createdBy: auditUpsell?.createdBy || null,
    updatedAt: serverTimestamp(),
  };

  await setDoc(auditUpsellRef, payload, { merge: true });
  return { dateKey, documentId };
}

export async function getAuditUpsell(hotelUid, dateKey, auditUpsellId) {
  if (!hotelUid || !dateKey || !auditUpsellId) return null;

  const auditUpsellRef = doc(
    db,
    `hotels/${hotelUid}/upselling/auditUpsell/${dateKey}/${auditUpsellId}`
  );
  const snapshot = await getDoc(auditUpsellRef);

  if (!snapshot.exists()) return null;

  return formatAuditUpsellData(snapshot.data() || {}, snapshot.id, dateKey);
}

export async function updateAuditUpsellValidation(
  hotelUid,
  dateKey,
  auditUpsellId,
  validationStatus,
  validationComment,
  currentUser,
  effectiveRevenue,
  operaUser
) {
  if (!hotelUid || !dateKey || !auditUpsellId) return;

  const auditUpsellRef = doc(
    db,
    `hotels/${hotelUid}/upselling/auditUpsell/${dateKey}/${auditUpsellId}`
  );

  const updateData = {
    validationStatus,
    validationComment,
    validatedAt: serverTimestamp(),
    validatedBy: currentUser || null,
  };

  if (effectiveRevenue !== undefined) {
    updateData.effectiveRevenue = effectiveRevenue;
  }

  if (operaUser !== undefined) {
    updateData.operaUser = String(operaUser || "").trim();
  }

  await updateDoc(auditUpsellRef, updateData);
}

export async function saveUpsellPackageCode(hotelUid, packageCode) {
  if (!hotelUid) return;

  const normalizedPackageCode = normalizePackageCodeDocument(packageCode);
  if (!normalizedPackageCode) return;

  const settingsRef = doc(db, `hotels/${hotelUid}/settings`, UPSELL_SETTINGS_DOC_ID);
  const packageCodeRef = doc(
    db,
    `hotels/${hotelUid}/settings/${UPSELL_SETTINGS_DOC_ID}/packagecodes`,
    normalizedPackageCode.packageCode
  );

  await Promise.all([
    setDoc(settingsRef, { updatedAt: new Date() }, { merge: true }),
    setDoc(packageCodeRef, {
      packageCode: normalizedPackageCode.packageCode,
      category: normalizedPackageCode.category,
      description: normalizedPackageCode.description,
      updatedAt: new Date(),
    }),
  ]);
}

export async function deleteUpsellPackageCode(hotelUid, packageCodeId) {
  if (!hotelUid || !packageCodeId) return;

  const settingsRef = doc(db, `hotels/${hotelUid}/settings`, UPSELL_SETTINGS_DOC_ID);
  const packageCodeRef = doc(db, `hotels/${hotelUid}/settings/${UPSELL_SETTINGS_DOC_ID}/packagecodes`, packageCodeId);

  await Promise.all([
    setDoc(settingsRef, { updatedAt: new Date() }, { merge: true }),
    deleteDoc(packageCodeRef),
  ]);
}


export async function saveUpsellDailyExpectedOccupancy(hotelUid, dailyExpectedOccupancy) {
  if (!hotelUid) return;

  const settingsRef = doc(db, `hotels/${hotelUid}/settings`, UPSELL_SETTINGS_DOC_ID);
  await setDoc(
    settingsRef,
    {
      dailyExpectedOccupancy: normalizeDailyExpectedOccupancy(dailyExpectedOccupancy),
      updatedAt: new Date(),
    },
    { merge: true }
  );
}

export async function saveUpsellRevenueTargetRules(hotelUid, revenueTargetRules) {
  if (!hotelUid) return;

  const settingsRef = doc(db, `hotels/${hotelUid}/settings`, UPSELL_SETTINGS_DOC_ID);
  await setDoc(
    settingsRef,
    {
      revenueTargetRules: normalizeRevenueTargetRules(revenueTargetRules),
      updatedAt: new Date(),
    },
    { merge: true }
  );
}

export function getUpsellDateKeys(startDate, endDate) {
  return enumerateDateKeys(startDate, endDate);
}
