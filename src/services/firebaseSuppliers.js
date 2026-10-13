import { auth, functions, httpsCallable } from "../firebaseConfig";
import { invalidateProcurementReads, poolProcurementRead, requireServerSnapshot } from "./procurementReadPool";
import {
  db,
  collection,
  getDocs,
  query,
  where,
} from "../firebaseConfig";

export async function getSuppliers(hotelUid) {
  if (!hotelUid) return [];
  return poolProcurementRead(hotelUid, "supplier-directory", async () => {
    const result = [];
    let afterId = null;
    const seen = new Set();
    do {
      const { data } = await httpsCallable(functions, "listSuppliers")({ hotelUid, afterId });
      if (!Array.isArray(data?.suppliers) || (data.nextCursor !== null && typeof data.nextCursor !== "string")) throw new Error("Supplier response is invalid.");
      result.push(...data.suppliers);
      if (result.length > 10000) throw new Error("More than 10,000 suppliers require a narrower directory.");
      afterId = data.nextCursor;
      if (afterId && seen.has(afterId)) throw new Error("Invalid supplier page cursor.");
      seen.add(afterId);
    } while (afterId);
    return result;
  });
}

export async function getSupplier(hotelUid, supplierId) {
  if (!hotelUid || !supplierId) return null;
  return poolProcurementRead(hotelUid, `supplier-detail:${supplierId}`, async () => (await httpsCallable(functions, "listSuppliers")({ hotelUid, supplierId })).data.supplier);
}

export async function getSupplierConnection(hotelUid, supplierId) {
  return (await httpsCallable(functions, "getSupplierConnection")({ hotelUid, supplierId })).data;
}

function splitSupplierInput(input) {
  const supplier = { ...input };
  const credentials = {};
  for (const field of ["username", "password", "sftpAddress", "sftpProtocol", "sftpPort", "sftpUser", "sftpPassword", "sftpHostKey"]) {
    if (Object.hasOwn(supplier, field)) credentials[field] = supplier[field];
    delete supplier[field];
  }
  return { supplier, ...(Object.keys(credentials).length ? { credentials } : {}) };
}

// Keep uncertain create requests in memory. Never persist credential input in browser storage.
const pendingSupplierCreates = new Map();
export async function createSupplier(hotelUid, supplierData) {
  const operationKey = `supplier-create:${hotelUid}:${JSON.stringify(supplierData)}`;
  const requestId = supplierData.requestId || pendingSupplierCreates.get(operationKey) || crypto.randomUUID();
  pendingSupplierCreates.set(operationKey, requestId);
  try {
    const { data } = await httpsCallable(functions, "saveSupplier")({ hotelUid, requestId, expectedRevision: 0, ...splitSupplierInput(supplierData) });
    pendingSupplierCreates.delete(operationKey);
    return data.supplierId;
  } finally { invalidateProcurementReads(hotelUid); }
}

export async function updateSupplier(hotelUid, supplierId, supplierData) {
  try {
    return (await httpsCallable(functions, "saveSupplier")({ hotelUid, supplierId, expectedRevision: supplierData.revision || 0, ...splitSupplierInput(supplierData) })).data;
  } finally { invalidateProcurementReads(hotelUid); }
}

export async function deleteSupplier(hotelUid, supplierId) {
  try {
    return (await httpsCallable(functions, "deleteSupplier")({ hotelUid, supplierId })).data;
  } finally { invalidateProcurementReads(hotelUid); }
}

export async function getSupplierOutletAccounts(hotelUid, options = {}) {
  if (!hotelUid) return [];

  const supplierIdFilter = String(options.supplierId || "").trim();
  const accountsCol = collection(db, `hotels/${hotelUid}/supplierOutletAccounts`);
  const snap = requireServerSnapshot(await getDocs(supplierIdFilter ? query(accountsCol, where("supplierId", "==", supplierIdFilter)) : accountsCol));

  return snap.docs
    .map((docSnap) => ({ ...(docSnap.data() || {}), id: docSnap.id }))
    .filter((item) => !supplierIdFilter || String(item.supplierId || "").trim() === supplierIdFilter)
    .sort((a, b) => {
      const supplierCompare = String(a.supplierName || a.supplierId || "").localeCompare(
        String(b.supplierName || b.supplierId || "")
      );
      if (supplierCompare !== 0) return supplierCompare;
      const outletCompare = String(a.outletName || a.outletId || "").localeCompare(String(b.outletName || b.outletId || ""));
      if (outletCompare !== 0) return outletCompare;
      return String(a.accountNumber || "").localeCompare(String(b.accountNumber || ""));
    });
}

// Reuse uncertain commands within this signed-in session. Revisions also protect a fresh session.
const pendingAccountCommands = new WeakMap();
async function saveAccount(hotelUid, payload) {
  const actor = auth.currentUser;
  if (!actor?.uid) throw new Error("Sign in before changing a supplier account.");
  if (!pendingAccountCommands.has(actor)) pendingAccountCommands.set(actor, new Map());
  const commands = pendingAccountCommands.get(actor), key = JSON.stringify([hotelUid, payload]);
  const command = commands.get(key) || { hotelUid, ...payload, requestId: crypto.randomUUID(), expectedActorUid: actor.uid };
  commands.set(key, command);
  try {
    const { data } = await httpsCallable(functions, "saveSupplierOutletAccount")(command);
    if (typeof data?.id !== "string" || !data.id || data.id.includes("/") || data.revision !== payload.expectedRevision + 1
      || payload.accountId && data.id !== payload.accountId) throw new Error("The account change response could not be verified. Reload the account list or retry the same change.");
    commands.delete(key);
    if (auth.currentUser !== actor) throw new Error("The signed-in account changed. Reload this view.");
    return data;
  } catch (error) {
    if (["invalid-argument", "permission-denied", "unauthenticated", "aborted", "already-exists", "not-found", "failed-precondition"].includes(String(error.code || "").replace(/^functions\//, ""))) commands.delete(key);
    throw error;
  } finally { invalidateProcurementReads(hotelUid); }
}

export async function createSupplierOutletAccount(hotelUid, payload) {
  return (await saveAccount(hotelUid, { supplierId: payload.supplierId, outletId: payload.outletId, accountNumber: payload.accountNumber, expectedRevision: 0 })).id;
}

export async function updateSupplierOutletAccount(hotelUid, account, accountNumber) {
  return saveAccount(hotelUid, { accountId: account.id, supplierId: account.supplierId, outletId: account.outletId,
    accountNumber, expectedRevision: account.revision ?? 0 });
}
