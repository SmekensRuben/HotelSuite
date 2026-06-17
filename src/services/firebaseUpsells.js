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

function formatAuditUpsellData(data, auditUpsellDocId, dateKey) {
  return {
    ...data,
    id: `${dateKey}-${auditUpsellDocId}`,
    documentId: auditUpsellDocId,
    dateKey,
    logDate: formatFirestoreValue(data.logDate || dateKey),
    logTime: formatFirestoreValue(data.logTime),
    operaUser: data.operaUser || "",
    packageCode: data.packageCode || "",
    startDate: formatFirestoreValue(data.startDate),
    endDate: formatFirestoreValue(data.endDate),
    arrivalDate: formatFirestoreValue(data.arrivalDate),
    departureDate: formatFirestoreValue(data.departureDate),
    price: data.price ?? "",
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

export async function getAuditUpsells(hotelUid, startDate, endDate) {
  if (!hotelUid) return [];

  const dateKeys = enumerateDateKeys(startDate, endDate);
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

  return snapshots.flatMap(({ dateKey, docs }) =>
    docs.map((auditUpsellDoc) => formatAuditUpsellData(auditUpsellDoc.data() || {}, auditUpsellDoc.id, dateKey))
  );
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
  effectiveRevenue
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
