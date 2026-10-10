const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { randomBytes } = require("node:crypto");
const { admin, getAppBaseUrl } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireHotelSubscription } = require("./subscriptions");
const { requirePrivateWorkflows, requireCurrentStaff } = require("./privateWorkflows");
const { strictId, contractDate } = require("./contractFiles");
const { text, revision, digest } = require("./validation");
const options = { region: "us-central1", cors: true, maxInstances: 10, concurrency: 20, timeoutSeconds: 60 };
const MAX_RESERVATIONS = 200, MAX_REQUESTS = 50;
const reservationFields = ["firstName", "lastName", "arrivalDate", "departureDate", "roomType", "numberOfAdults", "numberOfChildren", "comment"];
function accessToken(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{48,64}$/.test(value)) throw new HttpsError("not-found", "This rooming-list link is unavailable.");
  return value;
}
function nights(arrival, departure) {
  contractDate(arrival, "arrivalDate"); contractDate(departure, "departureDate");
  const start = Date.parse(arrival + "T00:00:00Z"), end = Date.parse(departure + "T00:00:00Z"), count = (end - start) / 86400000;
  if (count < 1 || count > 365) throw new HttpsError("invalid-argument", "A stay must have 1–365 checkout-exclusive nights.");
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
}
function capacitySnapshot(source) {
  if (Buffer.byteLength(JSON.stringify(source ?? null), "utf8") > 200000) throw new HttpsError("resource-exhausted", "Room allocation is too large for a single rooming list.");
  if (!Array.isArray(source) || !source.length || source.length > 365) throw new HttpsError("failed-precondition", "Review the group's room allocation before opening its rooming list.");
  const days = new Set();
  return source.map((day) => {
    const date = contractDate(day.date, "allocationDate");
    if (days.has(date) || !Array.isArray(day.roomTypes) || !day.roomTypes.length || day.roomTypes.length > 30) throw new HttpsError("failed-precondition", "Room allocation contains invalid or duplicate dates.");
    days.add(date); const codes = new Set();
    return { date, roomTypes: day.roomTypes.map((room) => {
      const code = text(room.code, "roomType", 64, true), name = text(room.name ?? "", "roomTypeName", 100);
      if (codes.has(code) || !Number.isSafeInteger(room.quantity) || room.quantity < 0 || room.quantity > 500) throw new HttpsError("failed-precondition", "Room allocations require unique room types and capacities of 0–500.");
      codes.add(code); return { code, name, quantity: room.quantity };
    }) };
  }).sort((a, b) => a.date.localeCompare(b.date));
}
function reservationInput(input, id, previous = {}, now = new Date().toISOString()) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => !reservationFields.includes(k))) throw new HttpsError("invalid-argument", "Unexpected reservation fields.");
  const result = { id: strictId(id, "reservationId"), firstName: text(input.firstName, "firstName", 80, true), lastName: text(input.lastName, "lastName", 80, true),
    arrivalDate: contractDate(input.arrivalDate, "arrivalDate"), departureDate: contractDate(input.departureDate, "departureDate"), roomType: text(input.roomType, "roomType", 64, true), comment: text(input.comment ?? "", "comment", 1000),
    createdAt: previous.createdAt || now, updatedAt: now };
  for (const field of ["numberOfAdults", "numberOfChildren"]) {
    if (!Number.isSafeInteger(input[field]) || input[field] < (field === "numberOfAdults" ? 1 : 0) || input[field] > 10) throw new HttpsError("invalid-argument", "Guest counts must be whole numbers between 0 and 10, with at least one adult.");
    result[field] = input[field];
  }
  nights(result.arrivalDate, result.departureDate); return result;
}
function validateReservations(root, reservations) {
  if (Buffer.byteLength(JSON.stringify(reservations ?? null), "utf8") > 500000) throw new HttpsError("resource-exhausted", "The guest list is too large. Shorten comments or ask the hotel to split the group.");
  if (!Array.isArray(reservations) || reservations.length > MAX_RESERVATIONS) throw new HttpsError("resource-exhausted", "A rooming list supports at most 200 reservations.");
  const capacities = new Map(capacitySnapshot(root.roomTypeDays).flatMap((day) => day.roomTypes.map((room) => [day.date + ":" + room.code, room.quantity])));
  const counts = new Map(), ids = new Set();
  for (const reservation of reservations) {
    if (ids.has(reservation.id)) throw new HttpsError("failed-precondition", "Duplicate reservation IDs need hotel review.");
    ids.add(reservation.id);
    const clean = reservationInput(Object.fromEntries(reservationFields.map((key) => [key, reservation[key]])), reservation.id, reservation);
    if (clean.arrivalDate < root.arrival || clean.departureDate > root.departure) throw new HttpsError("invalid-argument", "Reservations must fit the group's arrival and departure dates.");
    for (const date of nights(clean.arrivalDate, clean.departureDate)) {
      const key = date + ":" + clean.roomType, count = (counts.get(key) || 0) + 1;
      if (count > (capacities.get(key) || 0)) throw new HttpsError("failed-precondition", "No " + clean.roomType + " rooms are available on " + date + ".");
      counts.set(key, count);
    }
  }
}
function changesBetween(base, requested) {
  const before = new Map(base.map((r) => [r.id, r])), after = new Map(requested.map((r) => [r.id, r]));
  return { added: requested.filter((r) => !before.has(r.id)), removed: base.filter((r) => !after.has(r.id)), changed: requested.flatMap((r) => {
    const original = before.get(r.id); if (!original) return [];
    const fields = reservationFields.filter((k) => original[k] !== r[k]).map((field) => ({ field, from: original[field], to: r[field] }));
    return fields.length ? [{ id: r.id, before: original, after: r, fields }] : [];
  }) };
}
async function publicAccess(db, root, tx) {
  const expiry = root.publicAccessExpiresAt?.toMillis?.();
  if (root.publicAccessEnabled !== true || !Number.isFinite(expiry) || expiry <= Date.now()) throw new HttpsError("not-found", "This rooming-list link has expired or been disabled. Contact the hotel.");
  await requireHotelSubscription(db, root.hotelUid, tx, "groups");
}
function publicReservation(r) {
  return Object.fromEntries(["id", ...reservationFields, "createdAt", "updatedAt"].filter((k) => Object.hasOwn(r, k)).map((k) => [k, r[k]]));
}
function publicView(token, root, active) {
  // The organizer's link includes guest details for this group, never staff notes, audit actors, rejection reasons or other groups.
  return { id: token, groupName: root.groupName, arrival: root.arrival, departure: root.departure, roomTypeDays: root.roomTypeDays, roomTypes: root.roomTypes,
    status: root.status, revision: root.revision || 0, currentVersionNumber: root.currentVersionNumber || 0, reservations: (root.reservations || []).map(publicReservation),
    publicAccessEnabled: root.publicAccessEnabled === true, publicAccessExpiresAtMillis: root.publicAccessExpiresAt.toMillis(), versions: [], changeRequests: active ? [{ id: active.id, number: active.number, status: active.status,
      baseVersionNumber: active.baseVersionNumber, reservations: active.reservations.map(publicReservation) }] : [] };
}
async function getRoomingListHandler(request, services = {}) {
  const token = accessToken(request.data?.token), db = services.firestore || admin.firestore();
  const rootRef = db.doc("roomingListLinks/" + token);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(rootRef);
    if (!snap.exists) throw new HttpsError("not-found", "This rooming-list link is unavailable.");
    const root = snap.data();
    if (request.data?.internal === true) {
      await requireCurrentStaff(request, services.auth || admin.auth());
      await requireHotelPermission(db, request, root.hotelUid, "roominglists", "read", tx);
      await requireHotelSubscription(db, root.hotelUid, tx, "groups");
      const [versions, requests] = await Promise.all([tx.get(rootRef.collection("versions").orderBy("number", "desc").limit(10)), tx.get(rootRef.collection("changeRequests").orderBy("number", "desc").limit(10))]);
      if (versions.size > MAX_REQUESTS || requests.size > MAX_REQUESTS) throw new HttpsError("resource-exhausted", "This rooming list needs archival review.");
      return { ...publicView(token, { ...root, publicAccessExpiresAt: root.publicAccessExpiresAt || admin.firestore.Timestamp.fromMillis(0) }, null), hotelUid: root.hotelUid, groupId: root.groupId,
        versions: versions.docs.map((s) => ({ ...s.data(), id: s.id })).sort((a, b) => a.number - b.number), changeRequests: requests.docs.map((s) => ({ ...s.data(), id: s.id })).sort((a, b) => a.number - b.number) };
    }
    await requirePrivateWorkflows(db, tx); await publicAccess(db, root, tx);
    const group = await tx.get(db.doc("hotels/" + strictId(root.hotelUid, "hotelUid") + "/groups/" + strictId(root.groupId, "groupId")));
    if (!group.exists || group.data().roomingListToken !== token) throw new HttpsError("not-found", "This rooming-list link is unavailable.");
    const active = root.activeRequestId ? await tx.get(rootRef.collection("changeRequests").doc(root.activeRequestId)) : null;
    return publicView(token, root, active?.exists ? { ...active.data(), id: active.id } : null);
  });
}
async function createRoomingListHandler(request, services = {}) {
  const db = services.firestore || admin.firestore(), hotelUid = strictId(request.data?.hotelUid, "hotelUid"), groupId = strictId(request.data?.groupId, "groupId");
  const token = randomBytes(24).toString("hex"), rootRef = db.doc("roomingListLinks/" + token), groupRef = db.doc("hotels/" + hotelUid + "/groups/" + groupId);
  const appBaseUrl = services.appBaseUrl || getAppBaseUrl();
  return db.runTransaction(async (tx) => {
    await requirePrivateWorkflows(db, tx);
    await requireCurrentStaff(request, services.auth || admin.auth());
    await requireHotelPermission(db, request, hotelUid, "roominglists", "create", tx); await requireHotelSubscription(db, hotelUid, tx, "groups");
    const groupSnap = await tx.get(groupRef);
    if (!groupSnap.exists) throw new HttpsError("not-found", "Group not found.");
    const group = groupSnap.data();
    if (group.roomingListToken) {
      const previous = await tx.get(db.doc("roomingListLinks/" + accessToken(group.roomingListToken)));
      if (!previous.exists || previous.data().hotelUid !== hotelUid || previous.data().groupId !== groupId) throw new HttpsError("failed-precondition", "The existing link needs operator review.");
      return { token: group.roomingListToken, link: appBaseUrl + "/rooming-list/" + group.roomingListToken };
    }
    const arrival = contractDate(group.arrival, "arrival"), departure = contractDate(group.departure, "departure"); nights(arrival, departure);
    const roomTypeDays = capacitySnapshot(group.roomTypeDays), types = new Map();
    if (roomTypeDays.some((day) => day.date < arrival || day.date >= departure)) throw new HttpsError("failed-precondition", "Room allocations must fit the group dates.");
    roomTypeDays.forEach((day) => day.roomTypes.forEach(({ code, name }) => types.set(code, { code, name })));
    const expireAt = Math.min(Date.now() + 90 * 86400000, Date.parse(departure + "T00:00:00Z") + 7 * 86400000);
    if (expireAt <= Date.now()) throw new HttpsError("failed-precondition", "Create rooming lists only for current or upcoming groups.");
    const link = appBaseUrl + "/rooming-list/" + token;
    tx.create(rootRef, { hotelUid, groupId, groupName: text(group.groupName || "Group", "groupName", 200, true), arrival, departure, roomTypeDays, roomTypes: [...types.values()],
      status: "Not Started", reservations: [], currentVersionNumber: 0, revision: 0, activeRequestId: null, changeRequestNumber: 0,
      publicAccessEnabled: true, publicAccessExpiresAt: admin.firestore.Timestamp.fromMillis(expireAt), createdAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: request.auth.uid, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(groupRef, { roomingListToken: token, roomingListLink: link, roomingListStatus: "Not Started", updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: request.auth.uid });
    tx.create(rootRef.collection("audit").doc(), { action: "create", actorUid: request.auth.uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return { token, link };
  });
}
function rateUpdate(root, now = Date.now()) {
  const start = root.mutationWindowStart || 0, minute = root.mutationMinuteStart || 0;
  const count = now - start < 3600000 ? (root.mutationWindowCount || 0) + 1 : 1;
  const minuteCount = now - minute < 60000 ? (root.mutationMinuteCount || 0) + 1 : 1;
  const total = (root.mutationTotal || 0) + 1;
  if (count > 300 || minuteCount > 30 || total > 2000) throw new HttpsError("resource-exhausted", "This link's submission limit has been reached. Please wait or contact the hotel.");
  return { mutationWindowStart: count === 1 ? now : start, mutationWindowCount: count, mutationMinuteStart: minuteCount === 1 ? now : minute, mutationMinuteCount: minuteCount, mutationTotal: total };
}
async function mutateRoomingListHandler(request, services = {}) {
  const input = request.data || {}, token = accessToken(input.token), expectedRevision = revision(input.expectedRevision), requestId = strictId(input.requestId, "requestId");
  const actions = ["add", "update", "delete", "submit", "start-change", "cancel-change", "submit-change"];
  if (!actions.includes(input.action)) throw new HttpsError("invalid-argument", "Unknown rooming-list action.");
  const allowed = ["token", "expectedRevision", "requestId", "action", "reservationId", "reservation"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new HttpsError("invalid-argument", "Unexpected rooming-list fields.");
  const db = services.firestore || admin.firestore(), ref = db.doc("roomingListLinks/" + token), receipt = ref.collection("operations").doc(requestId), fingerprint = digest(input);
  return db.runTransaction(async (tx) => {
    await requirePrivateWorkflows(db, tx);
    const [snapshot, previous] = await Promise.all([tx.get(ref), tx.get(receipt)]);
    if (!snapshot.exists) throw new HttpsError("not-found", "This rooming-list link is unavailable.");
    const root = snapshot.data(); await publicAccess(db, root, tx);
    const groupRef = db.doc("hotels/" + strictId(root.hotelUid, "hotelUid") + "/groups/" + strictId(root.groupId, "groupId"));
    const group = await tx.get(groupRef);
    if (!group.exists || group.data().roomingListToken !== token) throw new HttpsError("not-found", "This rooming-list link is unavailable.");
    if (previous.exists) {
      if (previous.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "Request ID was already used for a different change.");
      return previous.data().result;
    }
    if ((root.revision || 0) !== expectedRevision) throw new HttpsError("aborted", "The rooming list changed. Reload and review before trying again.");
    const activeRef = root.activeRequestId ? ref.collection("changeRequests").doc(root.activeRequestId) : null;
    const activeSnap = activeRef ? await tx.get(activeRef) : null, active = activeSnap?.exists ? activeSnap.data() : null;
    if (root.activeRequestId && !active) throw new HttpsError("failed-precondition", "The active request needs hotel review.");
    let reservations = active?.status === "Draft" ? active.reservations : root.reservations || [];
    let result = {}, rootUpdate = { ...rateUpdate(root), revision: expectedRevision + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, groupUpdate = {};
    const now = new Date().toISOString();
    if (["add", "update", "delete"].includes(input.action)) {
      if (root.status === "Submitted" && active?.status !== "Draft") throw new HttpsError("failed-precondition", "The official rooming list is read-only. Start a change request first.");
      const id = strictId(input.reservationId, "reservationId"), existing = reservations.find((r) => r.id === id);
      if (input.action === "add" && existing) throw new HttpsError("already-exists", "Reservation already exists.");
      if (input.action !== "add" && !existing) throw new HttpsError("not-found", "Reservation not found.");
      if (input.action === "delete") reservations = reservations.filter((r) => r.id !== id);
      else {
        const reservation = reservationInput(input.reservation, id, existing || {}, now);
        reservations = input.action === "add" ? [...reservations, reservation] : reservations.map((r) => r.id === id ? reservation : r); result.reservation = reservation;
      }
      validateReservations(root, reservations);
      if (active) tx.update(activeRef, { reservations, updatedAt: now });
      else { rootUpdate.reservations = reservations; rootUpdate.status = "Concept"; groupUpdate.roomingListStatus = "Concept"; }
    } else if (input.action === "submit") {
      if (root.status === "Submitted" || active) throw new HttpsError("failed-precondition", "This list has already been submitted.");
      if (!reservations.length) throw new HttpsError("failed-precondition", "Add a reservation before submitting.");
      validateReservations(root, reservations);
      tx.create(ref.collection("versions").doc("1"), { number: 1, status: "Official", reservations, createdAt: now });
      Object.assign(rootUpdate, { status: "Submitted", currentVersionNumber: 1, submittedAt: admin.firestore.FieldValue.serverTimestamp() }); groupUpdate.roomingListStatus = "Submitted";
    } else if (input.action === "start-change") {
      if (root.status !== "Submitted" || active) throw new HttpsError("failed-precondition", "An official list without an active request is required.");
      const number = (root.changeRequestNumber || 0) + 1;
      if (number > MAX_REQUESTS || (root.currentVersionNumber || 0) >= MAX_REQUESTS) throw new HttpsError("resource-exhausted", "This list's revision history needs archival review.");
      const id = "change-" + requestId;
      const change = { number, status: "Draft", baseVersionNumber: root.currentVersionNumber, reservations, createdAt: now };
      tx.create(ref.collection("changeRequests").doc(id), change); Object.assign(rootUpdate, { activeRequestId: id, changeRequestNumber: number }); result.request = { id, ...change };
    } else {
      if (!active || active.status !== "Draft") throw new HttpsError("failed-precondition", "No draft change request is available.");
      if (input.action === "cancel-change") { tx.update(activeRef, { status: "Cancelled", cancelledAt: now }); rootUpdate.activeRequestId = null; groupUpdate.roomingListChangeRequestStatus = "Cancelled"; }
      else {
        validateReservations(root, reservations);
        const changes = changesBetween(root.reservations || [], reservations);
        if (!changes.added.length && !changes.removed.length && !changes.changed.length) throw new HttpsError("failed-precondition", "Make a change before submitting this request.");
        tx.update(activeRef, { status: "Pending Approval", submittedAt: now }); groupUpdate.roomingListChangeRequestStatus = "Pending Approval";
      }
    }
    result.revision = rootUpdate.revision;
    tx.update(ref, rootUpdate);
    if (Object.keys(groupUpdate).length) tx.update(groupRef, { ...groupUpdate, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.create(receipt, { fingerprint, result, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.create(ref.collection("audit").doc(), { action: input.action, source: "organizer-link", revision: result.revision, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return result;
  });
}
async function reviewRoomingListHandler(request, services = {}) {
  const input = request.data || {}, token = accessToken(input.token), id = strictId(input.changeRequestId, "changeRequestId"), expectedRevision = revision(input.expectedRevision), requestId = strictId(input.requestId, "requestId");
  if (!["approve", "reject"].includes(input.decision)) throw new HttpsError("invalid-argument", "Invalid review decision.");
  const reason = text(input.rejectionReason || "", "rejectionReason", 1000, input.decision === "reject");
  const db = services.firestore || admin.firestore(), ref = db.doc("roomingListLinks/" + token), changeRef = ref.collection("changeRequests").doc(id), receipt = ref.collection("operations").doc(requestId), fingerprint = digest(input);
  return db.runTransaction(async (tx) => {
    await requirePrivateWorkflows(db, tx);
    const rootSnap = await tx.get(ref);
    if (!rootSnap.exists) throw new HttpsError("not-found", "Rooming list not found.");
    const root = rootSnap.data();
    await requireCurrentStaff(request, services.auth || admin.auth());
    await requireHotelPermission(db, request, root.hotelUid, "roominglists", "approve", tx); await requireHotelSubscription(db, root.hotelUid, tx, "groups");
    const groupRef = db.doc("hotels/" + root.hotelUid + "/groups/" + root.groupId);
    const [change, previous, group] = await Promise.all([tx.get(changeRef), tx.get(receipt), tx.get(groupRef)]);
    if (!group.exists || group.data().roomingListToken !== token) throw new HttpsError("failed-precondition", "The linked group changed. Review it first.");
    if (previous.exists) {
      if (previous.data().fingerprint !== fingerprint || previous.data().actorUid !== request.auth.uid) throw new HttpsError("already-exists", "This review request ID is already in use.");
      return previous.data().result;
    }
    if ((root.revision || 0) !== expectedRevision) throw new HttpsError("aborted", "The rooming list changed. Reload before reviewing.");
    if (!change.exists || root.activeRequestId !== id || change.data().status !== "Pending Approval" || change.data().baseVersionNumber !== root.currentVersionNumber) throw new HttpsError("failed-precondition", "This request is no longer pending against the current official version.");
    const update = { revision: expectedRevision + 1, activeRequestId: null, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, now = new Date().toISOString();
    if (input.decision === "approve") {
      validateReservations(root, change.data().reservations);
      const number = root.currentVersionNumber + 1;
      if (number > MAX_REQUESTS) throw new HttpsError("resource-exhausted", "This list's revision history needs archival review.");
      tx.create(ref.collection("versions").doc(String(number)), { number, status: "Official", reservations: change.data().reservations, sourceRequestId: id, createdAt: now });
      Object.assign(update, { currentVersionNumber: number, reservations: change.data().reservations });
      tx.update(changeRef, { status: "Approved", approvedAt: now, approvedBy: request.auth.uid, approvedVersionNumber: number });
    } else tx.update(changeRef, { status: "Rejected", rejectedAt: now, rejectedBy: request.auth.uid, rejectionReason: reason });
    tx.update(ref, update); tx.update(groupRef, { roomingListChangeRequestStatus: input.decision === "approve" ? "Approved" : "Rejected", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    const result = { revision: update.revision, status: input.decision === "approve" ? "Approved" : "Rejected" };
    tx.create(receipt, { fingerprint, actorUid: request.auth.uid, result, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.create(ref.collection("audit").doc(), { action: input.decision, changeRequestId: id, actorUid: request.auth.uid, revision: update.revision, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return result;
  });
}
async function setRoomingListAccessHandler(request, services = {}) {
  const input = request.data || {}, token = accessToken(input.token), expectedRevision = revision(input.expectedRevision);
  if (typeof input.enabled !== "boolean" || !Number.isFinite(input.expiresAtMillis) || input.expiresAtMillis <= Date.now() || input.expiresAtMillis > Date.now() + 90 * 86400000) throw new HttpsError("invalid-argument", "Choose link access and an expiry within the next 90 days.");
  const db = services.firestore || admin.firestore(), ref = db.doc("roomingListLinks/" + token);
  return db.runTransaction(async (tx) => {
    await requirePrivateWorkflows(db, tx);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Rooming list not found.");
    await requireCurrentStaff(request, services.auth || admin.auth());
    await requireHotelPermission(db, request, snap.data().hotelUid, "roominglists", "update", tx); await requireHotelSubscription(db, snap.data().hotelUid, tx);
    if ((snap.data().revision || 0) !== expectedRevision) throw new HttpsError("aborted", "Reload before changing public access.");
    tx.update(ref, { publicAccessEnabled: input.enabled, publicAccessExpiresAt: admin.firestore.Timestamp.fromMillis(input.expiresAtMillis), revision: expectedRevision + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.create(ref.collection("audit").doc(), { action: "public-access", actorUid: request.auth.uid, enabled: input.enabled, expiresAtMillis: input.expiresAtMillis, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return { revision: expectedRevision + 1 };
  });
}
module.exports = { accessToken, nights, capacitySnapshot, reservationInput, validateReservations, changesBetween, publicView, rateUpdate,
  getRoomingListHandler, createRoomingListHandler, mutateRoomingListHandler, reviewRoomingListHandler, setRoomingListAccessHandler,
  getRoomingList: onCall(options, getRoomingListHandler), createRoomingList: onCall(options, createRoomingListHandler), mutateRoomingList: onCall(options, mutateRoomingListHandler),
  reviewRoomingList: onCall(options, reviewRoomingListHandler), setRoomingListAccess: onCall(options, setRoomingListAccessHandler) };
