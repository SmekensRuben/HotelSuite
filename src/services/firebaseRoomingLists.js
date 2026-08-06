import { db, doc, getDoc, setDoc, updateDoc, serverTimestamp } from "../firebaseConfig";

function createAccessToken() {
  const bytes = new Uint8Array(24);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getRoomTypeSnapshot(group) {
  const roomTypeDays = Array.isArray(group?.roomTypeDays) ? group.roomTypeDays : [];
  const roomTypeMap = new Map();

  roomTypeDays.forEach((day) => {
    (day.roomTypes || []).forEach((roomType) => {
      const code = String(roomType?.code || "").trim();
      if (!code) return;
      roomTypeMap.set(code, {
        code,
        name: String(roomType?.name || "").trim(),
      });
    });
  });

  return {
    roomTypeDays,
    roomTypes: Array.from(roomTypeMap.values()),
  };
}

function parseDateParts(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  return { year, month, day };
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDateRange(startDate, endDate) {
  const startParts = parseDateParts(startDate);
  const endParts = parseDateParts(endDate);
  if (!startParts || !endParts || endDate <= startDate) return [];

  const dates = [];
  const cursor = new Date(startParts.year, startParts.month - 1, startParts.day);
  const end = new Date(endParts.year, endParts.month - 1, endParts.day);
  while (cursor < end) {
    dates.push(formatDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function getRoomTypeDays(roomingList) {
  return Array.isArray(roomingList?.roomTypeDays) && roomingList.roomTypeDays.length > 0
    ? roomingList.roomTypeDays
    : Array.isArray(roomingList?.group?.roomTypeDays)
      ? roomingList.group.roomTypeDays
      : [];
}

function assertReservationAvailability(roomingList, reservation, existingReservations, ignoredReservationId = "") {
  const requestedDates = getDateRange(reservation.arrivalDate, reservation.departureDate);
  if (requestedDates.length === 0) throw new Error("Select a valid arrival and departure date.");

  const roomType = String(reservation.roomType || "").trim();
  const roomTypeDays = getRoomTypeDays(roomingList);

  requestedDates.forEach((date) => {
    const day = roomTypeDays.find((item) => item.date === date);
    const dayRoomType = day?.roomTypes?.find((item) => item.code === roomType);
    const capacity = Number(dayRoomType?.quantity || 0);
    const used = existingReservations.filter((existingReservation) => {
      if (ignoredReservationId && existingReservation.id === ignoredReservationId) return false;
      const existingDates = getDateRange(existingReservation.arrivalDate, existingReservation.departureDate);
      return existingDates.includes(date) && existingReservation.roomType === roomType;
    }).length;

    if (used + 1 > capacity) {
      throw new Error(`No ${roomType} rooms are available on ${date}.`);
    }
  });
}

function buildPublicLink(token) {
  const origin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";
  return `${origin}/rooming-list/${token}`;
}

function sanitizeReservation(reservation, id = createAccessToken().slice(0, 16)) {
  return {
    id,
    firstName: String(reservation.firstName || "").trim(),
    lastName: String(reservation.lastName || "").trim(),
    arrivalDate: String(reservation.arrivalDate || "").trim(),
    departureDate: String(reservation.departureDate || "").trim(),
    roomType: String(reservation.roomType || "").trim(),
    numberOfAdults: Math.max(0, Number(reservation.numberOfAdults || 0)),
    numberOfChildren: Math.max(0, Number(reservation.numberOfChildren || 0)),
    comment: String(reservation.comment || "").trim(),
    createdAt: reservation.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const RESERVATION_FIELDS = ["firstName", "lastName", "arrivalDate", "departureDate", "roomType", "numberOfAdults", "numberOfChildren", "comment"];

function copyReservations(reservations) {
  return (Array.isArray(reservations) ? reservations : []).map((reservation) => ({ ...reservation }));
}

function getActiveRequest(roomingList) {
  return (roomingList.changeRequests || []).find((request) => ["Draft", "Pending Approval"].includes(request.status)) || null;
}

function getEditableReservations(roomingList) {
  const request = getActiveRequest(roomingList);
  return request?.status === "Draft" ? request.reservations : roomingList.reservations;
}

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

function updateRequest(roomingList, requestId, changes) {
  return (roomingList.changeRequests || []).map((request) => request.id === requestId ? { ...request, ...changes } : request);
}

async function markRoomingListConcept(roomingList) {
  if (roomingList.hotelUid && roomingList.groupId) {
    await updateDoc(doc(db, `hotels/${roomingList.hotelUid}/groups/${roomingList.groupId}`), {
      roomingListStatus: "Concept",
      updatedAt: serverTimestamp(),
    });
  }
}

export function buildRoomingListLink(token) {
  return buildPublicLink(token);
}

export async function createRoomingListForGroup(hotelUid, group, actor) {
  if (!hotelUid) throw new Error("hotelUid is required");
  if (!group?.id) throw new Error("group is required");

  const existingToken = group.roomingListToken || "";
  const token = existingToken || createAccessToken();
  const link = buildPublicLink(token);
  const roomingListRef = doc(db, `roomingListLinks/${token}`);
  const roomTypeSnapshot = getRoomTypeSnapshot(group);

  if (!existingToken) {
    await setDoc(roomingListRef, {
      token,
      hotelUid,
      groupId: group.id,
      groupName: group.groupName || "",
      arrival: group.arrival || "",
      departure: group.departure || "",
      roomTypeDays: roomTypeSnapshot.roomTypeDays,
      roomTypes: roomTypeSnapshot.roomTypes,
      status: "Not Started",
      reservations: [],
      versions: [],
      changeRequests: [],
      currentVersionNumber: 0,
      createdAt: serverTimestamp(),
      createdBy: actor || "unknown",
      updatedAt: serverTimestamp(),
      updatedBy: actor || "unknown",
    });

    await updateDoc(doc(db, `hotels/${hotelUid}/groups/${group.id}`), {
      roomingListToken: token,
      roomingListLink: link,
      roomingListStatus: "Not Started",
      updatedAt: serverTimestamp(),
      updatedBy: actor || "unknown",
    });
  }

  return { token, link };
}

export async function getRoomingListByToken(token) {
  if (!token) return null;
  const snap = await getDoc(doc(db, `roomingListLinks/${token}`));
  if (!snap.exists()) return null;
  const roomingList = { id: snap.id, ...snap.data() };
  let group = null;

  try {
    const groupSnap = await getDoc(doc(db, `hotels/${roomingList.hotelUid}/groups/${roomingList.groupId}`));
    group = groupSnap.exists() ? { id: groupSnap.id, ...groupSnap.data() } : null;
  } catch (err) {
    console.warn("Unable to load linked group for public rooming list:", err);
  }

  return {
    ...roomingList,
    group,
  };
}

export async function addRoomingListReservation(token, reservation) {
  if (!token) throw new Error("token is required");
  const roomingList = await getRoomingListByToken(token);
  if (!roomingList) throw new Error("Rooming list not found.");

  const reservations = getEditableReservations(roomingList) || [];
  const activeRequest = getActiveRequest(roomingList);
  if (roomingList.status === "Submitted" && activeRequest?.status !== "Draft") throw new Error("The official rooming list is read-only.");

  const nextReservation = sanitizeReservation(reservation);
  assertReservationAvailability(roomingList, nextReservation, reservations);
  const nextReservations = [...reservations, nextReservation];

  const changes = activeRequest
    ? { changeRequests: updateRequest(roomingList, activeRequest.id, { reservations: nextReservations, updatedAt: new Date().toISOString() }) }
    : { reservations: nextReservations, status: "Concept" };
  await updateDoc(doc(db, `roomingListLinks/${token}`), { ...changes, updatedAt: serverTimestamp() });

  if (!activeRequest) await markRoomingListConcept(roomingList);

  return nextReservation;
}


export async function submitRoomingList(token) {
  if (!token) throw new Error("token is required");
  const roomingList = await getRoomingListByToken(token);
  if (!roomingList) throw new Error("Rooming list not found.");

  if (roomingList.status === "Submitted") throw new Error("This rooming list has already been submitted.");
  const reservations = copyReservations(roomingList.reservations);
  const version = { number: 1, status: "Official", reservations, createdAt: new Date().toISOString() };
  await updateDoc(doc(db, `roomingListLinks/${token}`), {
    status: "Submitted",
    versions: [version],
    currentVersionNumber: 1,
    reservations,
    submittedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  if (roomingList.hotelUid && roomingList.groupId) {
    await updateDoc(doc(db, `hotels/${roomingList.hotelUid}/groups/${roomingList.groupId}`), {
      roomingListStatus: "Submitted",
      updatedAt: serverTimestamp(),
    });
  }
}


export async function updateRoomingListReservation(token, reservationId, reservation) {
  if (!token) throw new Error("token is required");
  if (!reservationId) throw new Error("reservationId is required");
  const roomingList = await getRoomingListByToken(token);
  if (!roomingList) throw new Error("Rooming list not found.");

  const activeRequest = getActiveRequest(roomingList);
  if (roomingList.status === "Submitted" && activeRequest?.status !== "Draft") throw new Error("The official rooming list is read-only.");
  const reservations = getEditableReservations(roomingList) || [];
  const currentReservation = reservations.find((item) => item.id === reservationId);
  if (!currentReservation) throw new Error("Reservation not found.");

  const nextReservation = sanitizeReservation({ ...currentReservation, ...reservation }, reservationId);
  assertReservationAvailability(roomingList, nextReservation, reservations, reservationId);
  const nextReservations = reservations.map((item) => (item.id === reservationId ? nextReservation : item));

  const changes = activeRequest
    ? { changeRequests: updateRequest(roomingList, activeRequest.id, { reservations: nextReservations, updatedAt: new Date().toISOString() }) }
    : { reservations: nextReservations, status: "Concept" };
  await updateDoc(doc(db, `roomingListLinks/${token}`), { ...changes, updatedAt: serverTimestamp() });
  if (!activeRequest) await markRoomingListConcept(roomingList);
  return nextReservation;
}

export async function deleteRoomingListReservation(token, reservationId) {
  if (!token) throw new Error("token is required");
  if (!reservationId) throw new Error("reservationId is required");
  const roomingList = await getRoomingListByToken(token);
  if (!roomingList) throw new Error("Rooming list not found.");
  const activeRequest = getActiveRequest(roomingList);
  if (roomingList.status === "Submitted" && activeRequest?.status !== "Draft") throw new Error("The official rooming list is read-only.");
  const reservations = getEditableReservations(roomingList) || [];
  const nextReservations = reservations.filter((item) => item.id !== reservationId);
  if (nextReservations.length === reservations.length) throw new Error("Reservation not found.");

  const changes = activeRequest
    ? { changeRequests: updateRequest(roomingList, activeRequest.id, { reservations: nextReservations, updatedAt: new Date().toISOString() }) }
    : { reservations: nextReservations, status: "Concept" };
  await updateDoc(doc(db, `roomingListLinks/${token}`), { ...changes, updatedAt: serverTimestamp() });
  if (!activeRequest) await markRoomingListConcept(roomingList);
}

export async function createRoomingListChangeRequest(token) {
  const roomingList = await getRoomingListByToken(token);
  if (!roomingList || roomingList.status !== "Submitted") throw new Error("Only a submitted rooming list can be changed.");
  if (getActiveRequest(roomingList)) throw new Error("An active change request already exists.");
  const number = Math.max(0, ...(roomingList.changeRequests || []).map((request) => Number(request.number || 0))) + 1;
  const request = {
    id: createAccessToken().slice(0, 16), number, status: "Draft",
    baseVersionNumber: roomingList.currentVersionNumber || 1,
    reservations: copyReservations(roomingList.reservations), createdAt: new Date().toISOString(),
  };
  await updateDoc(doc(db, `roomingListLinks/${token}`), { changeRequests: [...(roomingList.changeRequests || []), request], updatedAt: serverTimestamp() });
  return request;
}

export async function cancelRoomingListChangeRequest(token) {
  const roomingList = await getRoomingListByToken(token);
  const request = getActiveRequest(roomingList || {});
  if (!request || request.status !== "Draft") throw new Error("No draft change request found.");
  await updateDoc(doc(db, `roomingListLinks/${token}`), { changeRequests: updateRequest(roomingList, request.id, { status: "Cancelled", cancelledAt: new Date().toISOString() }), updatedAt: serverTimestamp() });
}

export async function submitRoomingListChangeRequest(token) {
  const roomingList = await getRoomingListByToken(token);
  const request = getActiveRequest(roomingList || {});
  if (!request || request.status !== "Draft") throw new Error("No draft change request found.");
  request.reservations.forEach((reservation) => assertReservationAvailability(roomingList, reservation, request.reservations, reservation.id));
  const base = (roomingList.versions || []).find((version) => version.number === request.baseVersionNumber)?.reservations || roomingList.reservations;
  const submittedAt = new Date().toISOString();
  const updatedRequests = updateRequest(roomingList, request.id, { status: "Pending Approval", submittedAt, changes: calculateRoomingListChanges(base, request.reservations) });
  await updateDoc(doc(db, `roomingListLinks/${token}`), { changeRequests: updatedRequests, updatedAt: serverTimestamp() });
  await updateDoc(doc(db, `hotels/${roomingList.hotelUid}/groups/${roomingList.groupId}`), { roomingListChangeRequestStatus: "Pending Approval", updatedAt: serverTimestamp() });
}

export async function reviewRoomingListChangeRequest(token, requestId, decision, rejectionReason = "") {
  const roomingList = await getRoomingListByToken(token);
  const request = (roomingList?.changeRequests || []).find((item) => item.id === requestId);
  if (!request || request.status !== "Pending Approval") throw new Error("This change request is no longer pending.");
  if (decision === "approve") {
    const number = Number(roomingList.currentVersionNumber || 0) + 1;
    const version = { number, status: "Official", reservations: copyReservations(request.reservations), createdAt: new Date().toISOString(), sourceRequestId: request.id };
    await updateDoc(doc(db, `roomingListLinks/${token}`), {
      versions: [...(roomingList.versions || []), version], currentVersionNumber: number, reservations: version.reservations,
      changeRequests: updateRequest(roomingList, request.id, { status: "Approved", approvedAt: new Date().toISOString(), approvedVersionNumber: number }), updatedAt: serverTimestamp(),
    });
  } else if (decision === "reject") {
    await updateDoc(doc(db, `roomingListLinks/${token}`), { changeRequests: updateRequest(roomingList, request.id, { status: "Rejected", rejectedAt: new Date().toISOString(), rejectionReason: String(rejectionReason || "").trim() }), updatedAt: serverTimestamp() });
  } else throw new Error("Unknown review decision.");
  await updateDoc(doc(db, `hotels/${roomingList.hotelUid}/groups/${roomingList.groupId}`), { roomingListChangeRequestStatus: decision === "approve" ? "Approved" : "Rejected", updatedAt: serverTimestamp() });
}
