import { functions, httpsCallable } from "../firebaseConfig";
import {
  db,
  collection,
  getDocs,
} from "../firebaseConfig";

export async function getSuppliers(hotelUid) {
  if (!hotelUid) return [];
  const result = [];
  let afterId = null;
  const seen = new Set();
  do {
    const { data } = await httpsCallable(functions, "listSuppliers")({ hotelUid, afterId });
    result.push(...data.suppliers);
    afterId = data.nextCursor;
    if (afterId && seen.has(afterId)) throw new Error("Invalid supplier page cursor.");
    seen.add(afterId);
  } while (afterId);
  return result;
}

export async function getSupplier(hotelUid, supplierId) {
  if (!hotelUid || !supplierId) return null;
  return (await httpsCallable(functions, "listSuppliers")({ hotelUid, supplierId })).data.supplier;
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
  const { data } = await httpsCallable(functions, "saveSupplier")({ hotelUid, requestId, expectedRevision: 0, ...splitSupplierInput(supplierData) });
  pendingSupplierCreates.delete(operationKey);
  return data.supplierId;
}

export async function updateSupplier(hotelUid, supplierId, supplierData) {
  return (await httpsCallable(functions, "saveSupplier")({ hotelUid, supplierId, expectedRevision: supplierData.revision || 0, ...splitSupplierInput(supplierData) })).data;
}

export async function deleteSupplier(hotelUid, supplierId) {
  return (await httpsCallable(functions, "deleteSupplier")({ hotelUid, supplierId })).data;
}

export async function getSupplierOutletAccounts(hotelUid, options = {}) {
  if (!hotelUid) return [];

  const supplierIdFilter = String(options.supplierId || "").trim();
  const accountsCol = collection(db, `hotels/${hotelUid}/supplierOutletAccounts`);
  const snap = await getDocs(accountsCol);

  return snap.docs
    .map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }))
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

export async function createSupplierOutletAccount(hotelUid, payload) {
  return (await httpsCallable(functions, "saveSupplierOutletAccount")({ hotelUid,
    supplierId: payload.supplierId, outletId: payload.outletId, accountNumber: payload.accountNumber })).data.id;
}
