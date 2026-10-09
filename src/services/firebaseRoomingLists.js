import { functions, httpsCallable } from "../firebaseConfig";
const call = async (name, data) => (await httpsCallable(functions, name)(data)).data;
const revisions = new Map(), pendingOperations = new Map(), pendingAdds = new Map();
export function buildRoomingListLink(token) {
  return (typeof window !== "undefined" ? window.location.origin : "") + "/rooming-list/" + token;
}
export async function createRoomingListForGroup(hotelUid, group) {
  return call("createRoomingList", { hotelUid, groupId: group.id });
}
export async function getRoomingListByToken(token, options = {}) {
  if (!token) return null;
  const result = await call("getRoomingList", { token, internal: options.internal === true });
  revisions.set(token, result.revision);
  for (const [key, operation] of pendingOperations) if (operation.data.token === token && operation.result && operation.result.revision <= result.revision) pendingOperations.delete(key);
  for (const [key, operation] of pendingAdds) if (operation.token === token && operation.revision != null && operation.revision <= result.revision) pendingAdds.delete(key);
  return result;
}
async function mutation(name, token, input, internal = false) {
  if (!revisions.has(token)) await getRoomingListByToken(token, { internal });
  const key = JSON.stringify([name, token, input]);
  let operation = pendingOperations.get(key);
  if (!operation) { operation = { data: { token, ...input, expectedRevision: revisions.get(token), requestId: crypto.randomUUID() } }; pendingOperations.set(key, operation); }
  if (operation.result) return operation.result;
  try {
    const result = await call(name, operation.data);
    operation.result = result; revisions.set(token, result.revision); return result;
  } catch (error) {
    // An explicit conflict did not commit. A lost response retains its original operation ID for retry.
    if (["functions/aborted", "functions/invalid-argument", "functions/failed-precondition", "functions/permission-denied", "functions/not-found", "functions/resource-exhausted"].includes(error.code)) pendingOperations.delete(key);
    throw error;
  }
}
export async function addRoomingListReservation(token, reservation) {
  // Reuse the reservation ID with the pending operation after an uncertain response.
  const key = JSON.stringify([token, "add-reservation", reservation]);
  let operation = pendingAdds.get(key);
  if (!operation) { operation = { id: crypto.randomUUID(), token }; pendingAdds.set(key, operation); }
  const result = await mutation("mutateRoomingList", token, { action: "add", reservationId: operation.id, reservation });
  operation.revision = result.revision; return result.reservation;
}
export async function updateRoomingListReservation(token, reservationId, reservation) {
  return (await mutation("mutateRoomingList", token, { action: "update", reservationId, reservation })).reservation;
}
export async function deleteRoomingListReservation(token, reservationId) { await mutation("mutateRoomingList", token, { action: "delete", reservationId }); }
export async function submitRoomingList(token) { await mutation("mutateRoomingList", token, { action: "submit" }); }
export async function createRoomingListChangeRequest(token) { return (await mutation("mutateRoomingList", token, { action: "start-change" })).request; }
export async function cancelRoomingListChangeRequest(token) { await mutation("mutateRoomingList", token, { action: "cancel-change" }); }
export async function submitRoomingListChangeRequest(token) { await mutation("mutateRoomingList", token, { action: "submit-change" }); }
export async function reviewRoomingListChangeRequest(token, changeRequestId, decision, rejectionReason = "") {
  return mutation("reviewRoomingList", token, { changeRequestId, decision, rejectionReason }, true);
}
export async function setRoomingListPublicAccess(token, enabled, expiresAtMillis) {
  if (!revisions.has(token)) await getRoomingListByToken(token, { internal: true });
  const result = await call("setRoomingListAccess", { token, enabled, expiresAtMillis, expectedRevision: revisions.get(token) });
  revisions.set(token, result.revision); return result;
}
const RESERVATION_FIELDS = ["firstName", "lastName", "arrivalDate", "departureDate", "roomType", "numberOfAdults", "numberOfChildren", "comment"];

export function calculateRoomingListChanges(baseReservations = [], requestedReservations = []) {
  const baseById = new Map(baseReservations.map((reservation) => [reservation.id, reservation]));
  const requestedById = new Map(requestedReservations.map((reservation) => [reservation.id, reservation]));
  const added = requestedReservations.filter((reservation) => !baseById.has(reservation.id));
  const removed = baseReservations.filter((reservation) => !requestedById.has(reservation.id));
  const changed = [];

  requestedReservations.forEach((reservation) => {
    const original = baseById.get(reservation.id);
    if (!original) return;
    const fields = RESERVATION_FIELDS.filter((field) => original[field] !== reservation[field]).map((field) => ({
      field,
      from: original[field] ?? "",
      to: reservation[field] ?? "",
    }));
    if (fields.length) changed.push({ id: reservation.id, before: original, after: reservation, fields });
  });
  return { added, removed, changed };
}

export function calculateRoomTypePickupSummary(roomTypeDays = [], officialReservations = [], requestedReservations = []) {
  const isPickedUp = (reservation, date, roomType) => reservation.roomType === roomType
    && reservation.arrivalDate <= date && date < reservation.departureDate;
  const days = (Array.isArray(roomTypeDays) ? roomTypeDays : []).map((day) => {
    const roomTypes = (day.roomTypes || []).map((roomType) => {
      const blocked = Math.max(0, Number(roomType.quantity || 0));
      const officialPickedUp = officialReservations.filter((reservation) => isPickedUp(reservation, day.date, roomType.code)).length;
      const requestedPickedUp = requestedReservations.filter((reservation) => isPickedUp(reservation, day.date, roomType.code)).length;
      return {
        code: roomType.code,
        name: roomType.name || "",
        blocked,
        officialPickedUp,
        requestedPickedUp,
        pickupChange: requestedPickedUp - officialPickedUp,
        remaining: Math.max(0, blocked - requestedPickedUp),
      };
    });
    return {
      date: day.date,
      roomTypes,
      blocked: roomTypes.reduce((total, roomType) => total + roomType.blocked, 0),
      officialPickedUp: roomTypes.reduce((total, roomType) => total + roomType.officialPickedUp, 0),
      requestedPickedUp: roomTypes.reduce((total, roomType) => total + roomType.requestedPickedUp, 0),
      remaining: roomTypes.reduce((total, roomType) => total + roomType.remaining, 0),
    };
  });
  return {
    days,
    totals: {
      blocked: days.reduce((total, day) => total + day.blocked, 0),
      officialPickedUp: days.reduce((total, day) => total + day.officialPickedUp, 0),
      requestedPickedUp: days.reduce((total, day) => total + day.requestedPickedUp, 0),
      remaining: days.reduce((total, day) => total + day.remaining, 0),
    },
  };
}
