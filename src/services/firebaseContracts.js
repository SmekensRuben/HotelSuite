import { functions, httpsCallable, auth } from "../firebaseConfig";

export function calculateCancelBefore(endDate, terminationPeriodDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate || "")) return "";
  const days = Number(terminationPeriodDays), date = new Date(endDate + "T00:00:00Z");
  if (!Number.isFinite(days) || days < 0 || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== endDate) return "";
  date.setUTCDate(date.getUTCDate() - Math.floor(days));
  return date.toISOString().slice(0, 10);
}
const call = async (name, data) => (await httpsCallable(functions, name)(data)).data;
export async function getContracts(hotelUid) {
  if (!hotelUid) return [];
  const contracts = [], seen = new Set();
  let afterId = null;
  do {
    const page = await call("listHotelContracts", { hotelUid, afterId });
    contracts.push(...page.contracts); afterId = page.nextCursor;
    if (afterId && seen.has(afterId)) throw new Error("Invalid contract page cursor.");
    seen.add(afterId);
  } while (afterId);
  return contracts;
}
export async function getContract(hotelUid, contractId) {
  if (!hotelUid || !contractId) return null;
  const result = await call("listHotelContracts", { hotelUid, contractId });
  return result.contract ? { ...result.contract, privateWorkflowsEnabled: result.privateWorkflowsEnabled === true } : null;
}
export async function getContractFollowers(hotelUid, editing = false, withStatus = false) {
  if (!hotelUid) return [];
  const result = await call("listContractFollowers", { hotelUid, editing });
  return withStatus ? result : result.users;
}
async function documentRequest(method, data, file) {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to access contract documents.");
  const projectId = functions.app.options.projectId;
  const endpoint = "https://us-central1-" + projectId + ".cloudfunctions.net/contractDocument";
  const response = await fetch(endpoint + "?" + new URLSearchParams(data), {
    method, headers: { Authorization: "Bearer " + await user.getIdToken(), ...(file ? { "Content-Type": "application/octet-stream" } : {}) },
    ...(file ? { body: file } : {}), cache: "no-store",
  });
  if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || "Unable to access this document."); }
  return method === "GET" ? response.blob() : response.json();
}
export async function downloadContractFile(hotelUid, contractId, file) {
  const blob = await documentRequest("GET", { hotelUid, contractId, fileId: file.fileId });
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = file.fileName || "contract-document";
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Retain uncertain operation IDs and upload IDs only in memory. Retrying resumes the same save and attachments.
const pendingSaves = new Map();
async function saveContract(hotelUid, contractId, contractData, files, remainingFiles, creating, expectedRevision) {
  if (!hotelUid) throw new Error("hotelUid is required.");
  const selectedFiles = (Array.isArray(files) ? files : files ? [files] : []).filter(Boolean);
  if (selectedFiles.length + remainingFiles.length > 20 || selectedFiles.some((f) => !f.size || f.size > 20 * 1024 * 1024)) throw new Error("A contract supports up to 20 documents, each between 1 byte and 20 MiB.");
  const fields = ["name", "startDate", "endDate", "pricePerMonth", "terminationPeriodDays", "category", "categoryId", "subcategory", "subcategoryId", "reminderDays", "followers"];
  const contract = Object.fromEntries(fields.map((field) => [field, contractData[field]]));
  contract.followers = (contract.followers || []).map(({ id }) => ({ id }));
  const key = JSON.stringify([hotelUid, contractId, creating, expectedRevision, contract, remainingFiles.map((f) => f.fileId), selectedFiles.map((f) => [f.name, f.size, f.lastModified])]);
  let operation = pendingSaves.get(key);
  if (!operation) {
    operation = { requestId: crypto.randomUUID(), contractId: contractId || crypto.randomUUID(), fileIds: selectedFiles.map(() => crypto.randomUUID().replaceAll("-", "")) };
    pendingSaves.set(key, operation);
  }
  const result = await call("saveHotelContract", { hotelUid, contractId: operation.contractId, requestId: operation.requestId, creating, expectedRevision,
    contract, keepFileIds: remainingFiles.map((f) => f.fileId), uploadFileIds: operation.fileIds });
  // Upload sequentially to bound browser/backend memory use and make partial retries predictable.
  for (let i = 0; i < selectedFiles.length; i++) {
    await documentRequest("POST", { hotelUid, contractId: result.contractId, fileId: operation.fileIds[i], fileName: selectedFiles[i].name, creating: String(creating), requestId: operation.requestId }, selectedFiles[i]);
  }
  pendingSaves.delete(key);
  return result.contractId;
}
export async function createContract(hotelUid, contractData, files) {
  return saveContract(hotelUid, null, contractData, files, [], true, 0);
}
export async function updateContract(hotelUid, contractId, contractData, files, remainingFiles, _actor, expectedRevision = 0) {
  return saveContract(hotelUid, contractId, contractData, files, remainingFiles || [], false, expectedRevision);
}
export async function triggerContractReminders(hotelUid, actor) {
  // Existing reminders retain their permission-checked queue boundary.
  const { collection, db, doc, setDoc, serverTimestamp } = await import("../firebaseConfig");
  if (!hotelUid) throw new Error("hotelUid is required.");
  await setDoc(doc(collection(db, "hotels/" + hotelUid + "/contractReminderRuns")), { status: "queued", requestedAt: serverTimestamp(), requestedBy: actor || "unknown" });
}
