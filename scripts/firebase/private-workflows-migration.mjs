import { createHash } from "node:crypto";
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
export function attachmentDescriptor(file, hotelUid, contractId) {
  let path = file.filePath;
  if (!path && file.downloadUrl) {
    const url = new URL(file.downloadUrl);
    if (url.protocol !== "https:" || url.hostname !== "firebasestorage.googleapis.com") throw new Error("Unsupported legacy attachment URL needs review.");
    const match = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
    if (!match || decodeURIComponent(match[1]) !== "hotel-toolkit.firebasestorage.app") throw new Error("Legacy attachment bucket needs review.");
    path = decodeURIComponent(match[2]);
  }
  const legacy = "hotels/" + hotelUid + "/contracts/" + contractId + "/", privatePrefix = "private/contracts/" + hotelUid + "/" + contractId + "/";
  if (!idPattern.test(hotelUid) || !idPattern.test(contractId) || typeof path !== "string" || path.length > 1000
    || (!path.startsWith(legacy) && !path.startsWith(privatePrefix)) || path.split("/").some((p) => !p || [".", ".."].includes(p)) || /[\u0000-\u001f]/.test(path)) throw new Error("Attachment path is not scoped to its contract.");
  const fileId = file.fileId || createHash("sha256").update(path).digest("hex").slice(0, 32);
  if (!/^[a-f0-9]{32}$/.test(fileId) || (path.startsWith(privatePrefix) && path !== privatePrefix + fileId)) throw new Error("Invalid private attachment ID or path.");
  if (typeof file.fileName !== "string" || !file.fileName.trim() || file.fileName.length > 200 || /[\u0000-\u001f]/.test(file.fileName)) throw new Error("Attachment name needs review.");
  return { fileId, fileName: file.fileName.trim(), sourcePath: path, filePath: privatePrefix + fileId };
}
function contractFiles(data) {
  const source = data.contractFiles?.length ? data.contractFiles : data.contractFile ? [data.contractFile] : [];
  if (!Array.isArray(source) || source.length > 20) throw new Error("Contract has too many or malformed attachments.");
  return source;
}
export function validateLegacyRooming(root, requests) {
  const date = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
  const boundedText = (value, max, required = false) => typeof value === "string" && value.length <= max && (!required || value.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
  if (!date(root.arrival) || !date(root.departure) || root.departure <= root.arrival || (Date.parse(root.departure) - Date.parse(root.arrival)) / 86400000 > 365 || !["Not Started", "Concept", "Submitted"].includes(root.status)) throw new Error("Rooming-list dates or status need review.");
  if (Buffer.byteLength(JSON.stringify(root.roomTypeDays ?? null), "utf8") > 200000) throw new Error("Room allocation exceeds the reviewed document size.");
  if (!Array.isArray(root.roomTypeDays) || !root.roomTypeDays.length || root.roomTypeDays.length > 365) throw new Error("Room allocations need review.");
  const capacities = new Map(), days = new Set();
  for (const day of root.roomTypeDays) {
    if (!date(day.date) || days.has(day.date) || !Array.isArray(day.roomTypes) || !day.roomTypes.length || day.roomTypes.length > 30) throw new Error("Room allocation dates or types need review.");
    days.add(day.date); const codes = new Set();
    for (const room of day.roomTypes) {
      if (!boundedText(room.code, 64, true) || !boundedText(room.name || "", 100) || codes.has(room.code) || !Number.isSafeInteger(room.quantity) || room.quantity < 0 || room.quantity > 500) throw new Error("Room allocation quantities or codes need review.");
      codes.add(room.code); capacities.set(day.date + ":" + room.code, room.quantity);
    }
  }
  const checkReservations = (reservations) => {
    if (Buffer.byteLength(JSON.stringify(reservations ?? null), "utf8") > 500000) throw new Error("Guest list exceeds the reviewed document size.");
    if (!Array.isArray(reservations) || reservations.length > 200) throw new Error("Reservation bounds need review.");
    const ids = new Set(), counts = new Map();
    for (const r of reservations) {
      if (!idPattern.test(r.id) || ids.has(r.id) || !boundedText(r.firstName, 80, true) || !boundedText(r.lastName, 80, true) || !boundedText(r.comment || "", 1000) || !boundedText(r.roomType, 64, true) || !date(r.arrivalDate) || !date(r.departureDate) || r.departureDate <= r.arrivalDate || r.arrivalDate < root.arrival || r.departureDate > root.departure || !Number.isSafeInteger(r.numberOfAdults) || r.numberOfAdults < 1 || r.numberOfAdults > 10 || !Number.isSafeInteger(r.numberOfChildren) || r.numberOfChildren < 0 || r.numberOfChildren > 10) throw new Error("A reservation schema or guest count needs hotel review.");
      ids.add(r.id);
      for (let time = Date.parse(r.arrivalDate); time < Date.parse(r.departureDate); time += 86400000) {
        const key = new Date(time).toISOString().slice(0, 10) + ":" + r.roomType, count = (counts.get(key) || 0) + 1;
        if (count > (capacities.get(key) || 0)) throw new Error("A reservation exceeds snapshotted room capacity. Hotel review is required.");
        counts.set(key, count);
      }
    }
  };
  checkReservations(root.reservations);
  if (!Number.isSafeInteger(root.currentVersionNumber || 0) || (root.status === "Submitted" && !(root.currentVersionNumber >= 1))) throw new Error("Official rooming-list version needs review.");
  for (const request of requests.docs) {
    const data = request.data();
    if (!Number.isSafeInteger(data.number) || data.number < 1 || data.number > 50 || !["Draft", "Pending Approval", "Cancelled", "Approved", "Rejected"].includes(data.status)) throw new Error("Change-request history needs review.");
    if (["Draft", "Pending Approval"].includes(data.status)) {
      if (data.baseVersionNumber !== root.currentVersionNumber) throw new Error("An active request has a stale official base. Hotel review is required.");
      checkReservations(data.reservations);
    }
  }
}
export async function inspectPrivateWorkflows(db, bucket, { emulator = false } = {}) {
  const hotels = await db.collection("hotels").limit(501).get();
  if (hotels.size > 500) throw new Error("More than 500 hotels require a staged rollout.");
  const contracts = [], objects = [], roomingLists = [], issues = [];
  let legacyFiles = 0, legacyUrls = 0, tokens = 0;
  for (const hotel of hotels.docs) {
    if (!idPattern.test(hotel.id)) throw new Error("Hotel ID needs review.");
    const page = await db.collection("hotels/" + hotel.id + "/contracts").limit(1001).get();
    if (page.size > 1000) throw new Error("More than 1000 contracts in a hotel require a staged rollout.");
    for (const snapshot of page.docs) {
      try {
        if (!Number.isSafeInteger(snapshot.data().revision || 0) || (snapshot.data().revision || 0) < 0) throw new Error("Contract revision needs operator review.");
        const source = contractFiles(snapshot.data()), files = source.map((f) => attachmentDescriptor(f, hotel.id, snapshot.id));
        if (new Set(files.map((f) => f.fileId)).size !== files.length) throw new Error("Duplicate attachment IDs need review.");
        for (const file of files) {
          const [metadata] = await bucket.file(file.sourcePath).getMetadata();
          if (!(Number(metadata.size) > 0 && Number(metadata.size) <= 20 * 1024 * 1024)) throw new Error("Missing, empty or oversized attachment needs review.");
          if (metadata.acl?.some((entry) => ["allUsers", "allAuthenticatedUsers"].includes(entry.entity))) throw new Error("A publicly shared object ACL needs operator review.");
          if (metadata.contentEncoding && metadata.contentEncoding !== "identity") throw new Error("Encoded contract bytes need operator review before migration.");
          file.generation = metadata.generation; file.metageneration = metadata.metageneration; file.size = Number(metadata.size);
          if (file.sourcePath !== file.filePath) legacyFiles++;
        }
        legacyUrls += source.filter((f) => Object.hasOwn(f, "downloadUrl")).length + (Object.hasOwn(snapshot.data(), "contractFile") ? 1 : 0);
        contracts.push({ snapshot, files });
      } catch (error) { issues.push({ hotelUid: hotel.id, contractId: snapshot.id, issue: error.message }); }
    }
  }
  // Include abandoned uploads and objects belonging to deleted hotels, plus every
  // retained object generation. No copied token URL may survive this inventory.
  if (!emulator) {
    const [policy] = await bucket.iam.getPolicy();
    if (policy.bindings?.some((binding) => binding.members?.some((member) => ["allUsers", "allAuthenticatedUsers"].includes(member)))) throw new Error("Public bucket IAM needs operator review before private-file activation.");
  }
  if (!emulator) {
    const [metadata] = await bucket.getMetadata();
    if (metadata.defaultObjectAcl?.some((entry) => ["allUsers", "allAuthenticatedUsers"].includes(entry.entity))) throw new Error("Public default object ACL needs operator review.");
  }
  for (const prefix of ["hotels/", "private/contracts/"]) {
    const [files, nextQuery] = await bucket.getFiles({ prefix, versions: true, maxResults: 10001, autoPaginate: false });
    if (files.length > 10000 || nextQuery) throw new Error("More than 10000 bucket objects require a staged inventory.");
    for (const object of files) {
      if (prefix === "hotels/" && object.name.split("/")[2] !== "contracts") continue;
      const [metadata] = await object.getMetadata();
      if (metadata.acl?.some((entry) => ["allUsers", "allAuthenticatedUsers"].includes(entry.entity))) throw new Error("A publicly shared object ACL needs operator review.");
      if (metadata.metadata?.firebaseStorageDownloadTokens) tokens++;
      objects.push({ name: object.name, generation: metadata.generation, metadata });
    }
  }
  const page = await db.collection("roomingListLinks").limit(501).get();
  if (page.size > 500) throw new Error("More than 500 rooming lists require a staged rollout.");
  for (const snapshot of page.docs) {
    try {
      const root = snapshot.data();
      if (!/^[a-f0-9]{48,64}$/.test(snapshot.id) || !idPattern.test(root.hotelUid) || !idPattern.test(root.groupId)) throw new Error("Rooming-list ownership or token format needs review.");
      const group = await db.doc("hotels/" + root.hotelUid + "/groups/" + root.groupId).get();
      if (!group.exists || group.data().roomingListToken !== snapshot.id) throw new Error("Rooming-list ownership differs from its group.");
      if (!Array.isArray(root.reservations) || root.reservations.length > 200 || !Array.isArray(root.roomTypeDays) || root.roomTypeDays.length > 365) throw new Error("Rooming-list bounds need review.");
      const [requests, versions] = await Promise.all([snapshot.ref.collection("changeRequests").limit(51).get(), snapshot.ref.collection("versions").limit(51).get()]);
      if (requests.size > 50 || versions.size > 50) throw new Error("Rooming-list history needs archival review.");
      validateLegacyRooming(root, requests);
      const active = requests.docs.filter((r) => ["Draft", "Pending Approval"].includes(r.data().status));
      if (active.length > 1) throw new Error("Multiple active requests need hotel review.");
      roomingLists.push({ snapshot, requests, activeRequestId: active[0]?.id || null, changeRequestNumber: Math.max(0, ...requests.docs.map((r) => Number(r.data().number || 0))) });
    } catch (error) { issues.push({ roomingList: createHash("sha256").update(snapshot.id).digest("hex").slice(0, 12), issue: error.message }); }
  }
  return { contracts, objects, roomingLists, summary: { hotels: hotels.size, contracts: contracts.length, legacyFiles, legacyUrls, downloadTokens: tokens, roomingLists: roomingLists.length, issues } };
}
async function revokeObjectTokens(bucket, object) {
  const file = bucket.file(object.name, object.generation ? { generation: object.generation } : {}), [current] = await file.getMetadata();
  if (!current.metadata?.firebaseStorageDownloadTokens) return;
  await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: null }, cacheControl: "private, no-store" }, { ifMetagenerationMatch: current.metageneration });
  const [verified] = await file.getMetadata();
  if (verified.metadata?.firebaseStorageDownloadTokens) throw new Error("A legacy object still has a download token. Activation remains blocked.");
}
export async function migratePrivateWorkflows(db, bucket, inspection, fieldValue, actor) {
  if (inspection.summary.issues.length) throw new Error("Resolve preflight issues before migration.");
  for (const entry of inspection.contracts) {
    if (entry.files.every((f) => f.sourcePath === f.filePath) && !Object.hasOwn(entry.snapshot.data(), "contractFile") && !contractFiles(entry.snapshot.data()).some((f) => Object.hasOwn(f, "downloadUrl"))) continue;
    const attachments = [];
    for (const file of entry.files) {
      const source = bucket.file(file.sourcePath, { generation: file.generation }), destination = bucket.file(file.filePath);
      const [bytes] = await source.download({ decompress: false }), sha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== file.size || bytes.length > 20 * 1024 * 1024) throw new Error("Contract file size changed during migration.");
      if (file.sourcePath !== file.filePath) {
        try { await destination.save(bytes, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: "application/octet-stream", cacheControl: "private, no-store", metadata: { sha256 } } }); }
        catch (error) {
          if (error.code !== 412) throw error;
          const [existing] = await destination.download({ decompress: false });
          if (createHash("sha256").update(existing).digest("hex") !== sha256) throw new Error("A private destination differs from the legacy document. Review before retrying.");
        }
      }
      const [destinationMeta] = await destination.getMetadata();
      const [verifiedBytes] = await destination.download({ decompress: false });
      if (Number(destinationMeta.size) !== bytes.length || createHash("sha256").update(verifiedBytes).digest("hex") !== sha256) throw new Error("Private file verification failed.");
      await revokeObjectTokens(bucket, { name: file.filePath });
      attachments.push({ fileId: file.fileId, fileName: file.fileName, filePath: file.filePath, size: bytes.length });
    }
    await db.runTransaction(async (tx) => {
      const current = await tx.get(entry.snapshot.ref);
      if (!current.exists || JSON.stringify(contractFiles(current.data())) !== JSON.stringify(contractFiles(entry.snapshot.data())) || (current.data().revision || 0) !== (entry.snapshot.data().revision || 0)) throw new Error("A contract changed during migration. Activation remains blocked.");
      const revision = (current.data().revision || 0) + 1;
      tx.update(current.ref, { contractFiles: attachments, contractFile: fieldValue.delete(), revision, filesMigratedAt: fieldValue.serverTimestamp(), filesMigratedBy: actor });
      tx.create(db.collection("hotels/" + current.ref.parent.parent.id + "/contractAudit").doc(), { action: "private-file-migration", contractId: current.id, actorUid: actor, revision, createdAt: fieldValue.serverTimestamp() });
    });
  }
  // Revoke old tokens after documents point at verified private copies. Legacy bytes are retained for operator review.
  for (const object of inspection.objects) await revokeObjectTokens(bucket, object);
  for (const entry of inspection.roomingLists) await db.runTransaction(async (tx) => {
    const current = await tx.get(entry.snapshot.ref);
    if (!current.exists || current.updateTime.toMillis() !== entry.snapshot.updateTime.toMillis()) throw new Error("A rooming list changed during migration. Review before retrying.");
    const update = { activeRequestId: entry.activeRequestId, changeRequestNumber: entry.changeRequestNumber, revision: (current.data().revision || 0) + 1, migratedAt: fieldValue.serverTimestamp() };
    // Missing/expired legacy public access is never automatically enabled or extended.
    if (current.data().publicAccessEnabled !== true || !Number.isFinite(current.data().publicAccessExpiresAt?.toMillis?.())) update.publicAccessEnabled = false;
    tx.update(current.ref, update);
  });
}
