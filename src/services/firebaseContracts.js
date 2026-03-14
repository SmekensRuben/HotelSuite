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

function buildContractPayload(contractData, actor, existingFileMeta = null) {
  const terminationPeriodDays = Number(contractData.terminationPeriodDays);

  return {
    name: String(contractData.name || "").trim(),
    startDate: normalizeDateInput(contractData.startDate),
    endDate: normalizeDateInput(contractData.endDate),
    terminationPeriodDays: Number.isFinite(terminationPeriodDays) ? Math.max(0, Math.floor(terminationPeriodDays)) : 0,
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
    contractFile: existingFileMeta,
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
  return { id: snap.id, ...snap.data() };
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

export async function createContract(hotelUid, contractData, contractFile, actor) {
  if (!hotelUid) throw new Error("hotelUid is verplicht!");

  const contractsCol = collection(db, `hotels/${hotelUid}/contracts`);
  const contractDocRef = doc(contractsCol);

  let fileMeta = null;
  if (contractFile) {
    fileMeta = await uploadContractFile(hotelUid, contractDocRef.id, contractFile);
  }

  const payload = {
    ...buildContractPayload(contractData, actor, fileMeta),
    createdAt: serverTimestamp(),
    createdBy: actor || "unknown",
  };

  await setDoc(contractDocRef, payload);
  return contractDocRef.id;
}

export async function updateContract(hotelUid, contractId, contractData, contractFile, actor) {
  if (!hotelUid || !contractId) throw new Error("hotelUid en contractId zijn verplicht!");

  const contractRef = doc(db, `hotels/${hotelUid}/contracts`, contractId);
  const existingSnap = await getDoc(contractRef);
  if (!existingSnap.exists()) throw new Error("Contract niet gevonden");

  const existingData = existingSnap.data() || {};
  let fileMeta = existingData.contractFile || null;

  if (contractFile) {
    fileMeta = await uploadContractFile(hotelUid, contractId, contractFile);
  }

  const payload = buildContractPayload(contractData, actor, fileMeta);
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
