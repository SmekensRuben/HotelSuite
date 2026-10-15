import { functions, auth } from "../firebaseConfig";
import { procurementReadScope } from "./procurementReadPool";

export const PURCHASE_REQUEST_ATTACHMENT_ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.txt,.csv";
export const MAX_PURCHASE_REQUEST_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const pendingUploads = new Map();

async function documentRequest(method, data, file) {
  const user = auth.currentUser;
  const scope = procurementReadScope(data.hotelUid);
  if (!user || !scope) throw new Error("Sign in to access purchase request documents.");
  const assertCurrent = () => { if (auth.currentUser !== user || !scope.current()) throw new Error("Your hotel access changed. Reopen this request before accessing documents."); };
  const endpoint = "https://us-central1-" + functions.app.options.projectId + ".cloudfunctions.net/purchaseRequestDocument";
  const token = await user.getIdToken();
  assertCurrent();
  const response = await fetch(endpoint + "?" + new URLSearchParams(data), {
    method, headers: { Authorization: "Bearer " + token, ...(file ? { "Content-Type": "application/octet-stream" } : {}) },
    ...(file ? { body: file } : {}), cache: "no-store",
  });
  assertCurrent();
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "Unable to access this document.");
  }
  const result = await (method === "GET" ? response.blob() : response.json());
  assertCurrent();
  return result;
}

export async function uploadPurchaseRequestAttachment(hotelUid, purchaseRequestId, file, expectedRevision) {
  if (!hotelUid || !purchaseRequestId) throw new Error("Save the purchase request before adding documents.");
  if (!auth.currentUser?.uid) throw new Error("Sign in before adding documents.");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("Reload the saved purchase request before adding documents.");
  if (!file || !file.size || file.size > MAX_PURCHASE_REQUEST_ATTACHMENT_BYTES) throw new Error("Choose a document between 1 byte and 10 MiB.");
  if (!/\.(pdf|png|jpe?g|docx|xlsx|txt|csv)$/i.test(file.name)) throw new Error("Supported attachments are PDF, PNG, JPEG, DOCX, XLSX, TXT and CSV.");
  const key = JSON.stringify([auth.currentUser.uid, hotelUid, purchaseRequestId, expectedRevision, file.name, file.size, file.lastModified]);
  let upload = pendingUploads.get(key);
  // A File reference prevents a same-name replacement from reusing another
  // upload's ID. Interrupted retries with the same File retain their identity.
  if (!upload || upload.file !== file) {
    upload = { file, fileId: crypto.randomUUID().replaceAll("-", "") };
    pendingUploads.set(key, upload);
  }
  const result = await documentRequest("POST", { hotelUid, purchaseRequestId, fileId: upload.fileId, fileName: file.name,
    expectedRevision: String(expectedRevision) }, file);
  pendingUploads.delete(key);
  return result;
}

// Downloaded data remains a Blob. The component decides when to create a short
// lived local object URL and must revoke it after starting a download.
export function downloadPurchaseRequestAttachment(hotelUid, purchaseRequestId, attachment, revision) {
  if (!hotelUid || !purchaseRequestId || !attachment?.fileId) throw new Error("Choose a document from this request.");
  return documentRequest("GET", { hotelUid, purchaseRequestId, fileId: attachment.fileId, ...(revision !== undefined ? { revision: String(revision) } : {}) });
}
