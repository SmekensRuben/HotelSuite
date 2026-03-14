import {
  db,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  serverTimestamp,
  storage,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "../firebaseConfig";

function normalizeDateInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

export function calculateCancelBefore(endDate, terminationPeriodDays) {
  const normalizedEndDate = normalizeDateInput(endDate);
  const days = Number(terminationPeriodDays);
  if (!normalizedEndDate || !Number.isFinite(days) || days < 0) return "";

  const [year, month, day] = normalizedEndDate.split("-").map(Number);
  const endDateUtc = new Date(Date.UTC(year, month - 1, day));
  endDateUtc.setUTCDate(endDateUtc.getUTCDate() - Math.floor(days));
  return endDateUtc.toISOString().slice(0, 10);
}

function sanitizeReminderDays(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((day) => Number(day))
      .filter((day) => Number.isFinite(day) && day >= 0)
      .map((day) => Math.floor(day))
  )].sort((a, b) => b - a);
}

function sanitizeFiles(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((file) => ({
      fileName: String(file?.fileName || "").trim(),
      filePath: String(file?.filePath || "").trim(),
      downloadUrl: String(file?.downloadUrl || "").trim(),
    }))
    .filter((file) => file.fileName && file.downloadUrl);
}

function buildContractPayload(contractData, actor, existingFiles = []) {
  const terminationPeriodDays = Number(contractData.terminationPeriodDays);

  return {
    name: String(contractData.name || "").trim(),
    startDate: normalizeDateInput(contractData.startDate),
    endDate: normalizeDateInput(contractData.endDate),
    terminationPeriodDays: Number.isFinite(terminationPeriodDays)
      ? Math.max(0, Math.floor(terminationPeriodDays))
      : 0,
    cancelBefore: calculateCancelBefore(contractData.endDate, terminationPeriodDays),
    category: String(contractData.category || "").trim(),
    reminderDays: sanitizeReminderDays(contractData.reminderDays),
    followers: Array.isArray(contractData.followers)
      ? contractData.followers
          .map((follower) => ({
            id: String(follower?.id || "").trim(),
            email: String(follower?.email || "").trim(),
            name: String(follower?.name || "").trim(),
          }))
          .filter((follower) => follower.id && follower.email)
      : [],
    contractFiles: sanitizeFiles(existingFiles),
    updatedAt: serverTimestamp(),
    updatedBy: actor || "unknown",
  };
}

export async function getContracts(hotelUid) {
  if (!hotelUid) return [];
  const contractsCol = collection(db, `hotels/${hotelUid}/contracts`);
  const snap = await getDocs(contractsCol);
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

export async function getContract(hotelUid, contractId) {
  if (!hotelUid || !contractId) return null;
  const contractDoc = doc(db, `hotels/${hotelUid}/contracts`, contractId);
  const snap = await getDoc(contractDoc);
  if (!snap.exists()) return null;

  const data = snap.data() || {};
  const contractFiles = sanitizeFiles(data.contractFiles);
  const legacyFile = data.contractFile
    ? sanitizeFiles([data.contractFile])
    : [];

  return {
    id: snap.id,
    ...data,
    contractFiles: contractFiles.length ? contractFiles : legacyFile,
  };
}

async function uploadContractFile(hotelUid, contractId, file) {
  const safeFileName = file.name.replace(/\s+/g, "-");
  const filePath = `hotels/${hotelUid}/contracts/${contractId}/${Date.now()}-${safeFileName}`;
  const fileRef = ref(storage, filePath);
  await uploadBytes(fileRef, file);
  const downloadUrl = await getDownloadURL(fileRef);
  return {
    fileName: file.name,
    filePath,
    downloadUrl,
  };
}

async function uploadContractFiles(hotelUid, contractId, files) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const uploads = await Promise.all(files.map((file) => uploadContractFile(hotelUid, contractId, file)));
  return sanitizeFiles(uploads);
}

function toFileArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

export async function createContract(hotelUid, contractData, contractFiles, actor) {
  if (!hotelUid) throw new Error("hotelUid is verplicht!");

  const contractsCol = collection(db, `hotels/${hotelUid}/contracts`);
  const contractDocRef = doc(contractsCol);

  const uploadedFiles = await uploadContractFiles(
    hotelUid,
    contractDocRef.id,
    toFileArray(contractFiles)
  );

  const payload = {
    ...buildContractPayload(contractData, actor, uploadedFiles),
    createdAt: serverTimestamp(),
    createdBy: actor || "unknown",
  };

  await setDoc(contractDocRef, payload);
  return contractDocRef.id;
}

export async function updateContract(hotelUid, contractId, contractData, contractFiles, remainingFiles, actor) {
  if (!hotelUid || !contractId) throw new Error("hotelUid en contractId zijn verplicht!");

  const contractRef = doc(db, `hotels/${hotelUid}/contracts`, contractId);
  const existingSnap = await getDoc(contractRef);
  if (!existingSnap.exists()) throw new Error("Contract niet gevonden");

  const existingData = existingSnap.data() || {};
  const existingFiles = sanitizeFiles(existingData.contractFiles || []);
  const fallbackLegacy = existingFiles.length ? [] : sanitizeFiles([existingData.contractFile]);
  const currentFiles = [...existingFiles, ...fallbackLegacy];
  const keptFiles = sanitizeFiles(remainingFiles);

  const filesToDelete = currentFiles.filter((currentFile) =>
    !keptFiles.some(
      (keptFile) =>
        (currentFile.filePath && keptFile.filePath && currentFile.filePath === keptFile.filePath) ||
        (currentFile.downloadUrl && keptFile.downloadUrl && currentFile.downloadUrl === keptFile.downloadUrl)
    )
  );

  await Promise.all(
    filesToDelete
      .filter((file) => file.filePath)
      .map((file) => deleteObject(ref(storage, file.filePath)).catch(() => null))
  );

  const uploadedFiles = await uploadContractFiles(hotelUid, contractId, toFileArray(contractFiles));
  const allFiles = [...keptFiles, ...uploadedFiles];

  const payload = buildContractPayload(contractData, actor, allFiles);
  await updateDoc(contractRef, payload);
}

export async function triggerContractReminders(hotelUid, actor) {
  if (!hotelUid) throw new Error("hotelUid is verplicht!");

  const runsCol = collection(db, `hotels/${hotelUid}/contractReminderRuns`);
  await setDoc(doc(runsCol), {
    status: "queued",
    requestedAt: serverTimestamp(),
    requestedBy: actor || "unknown",
  });
}
