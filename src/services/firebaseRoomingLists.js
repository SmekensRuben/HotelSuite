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

  const reservations = Array.isArray(roomingList.reservations) ? roomingList.reservations : [];
  if (roomingList.status === "Submitted") throw new Error("This rooming list has already been submitted.");

  const nextReservation = sanitizeReservation(reservation);
  assertReservationAvailability(roomingList, nextReservation, reservations);
  const nextReservations = [...reservations, nextReservation];

  await updateDoc(doc(db, `roomingListLinks/${token}`), {
    reservations: nextReservations,
    status: "Concept",
    updatedAt: serverTimestamp(),
  });

  await markRoomingListConcept(roomingList);

  return nextReservation;
}


export async function submitRoomingList(token) {
  if (!token) throw new Error("token is required");
  const roomingList = await getRoomingListByToken(token);
  if (!roomingList) throw new Error("Rooming list not found.");

  await updateDoc(doc(db, `roomingListLinks/${token}`), {
    status: "Submitted",
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

  const reservations = Array.isArray(roomingList.reservations) ? roomingList.reservations : [];
  const currentReservation = reservations.find((item) => item.id === reservationId);
  if (!currentReservation) throw new Error("Reservation not found.");

  const nextReservation = sanitizeReservation({ ...currentReservation, ...reservation }, reservationId);
  assertReservationAvailability(roomingList, nextReservation, reservations, reservationId);
  const nextReservations = reservations.map((item) => (item.id === reservationId ? nextReservation : item));

  await updateDoc(doc(db, `roomingListLinks/${token}`), {
    reservations: nextReservations,
    status: "Concept",
    updatedAt: serverTimestamp(),
  });
  await markRoomingListConcept(roomingList);
  return nextReservation;
}

export async function deleteRoomingListReservation(token, reservationId) {
  if (!token) throw new Error("token is required");
  if (!reservationId) throw new Error("reservationId is required");
  const roomingList = await getRoomingListByToken(token);
  if (!roomingList) throw new Error("Rooming list not found.");

  const reservations = Array.isArray(roomingList.reservations) ? roomingList.reservations : [];
  const nextReservations = reservations.filter((item) => item.id !== reservationId);
  if (nextReservations.length === reservations.length) throw new Error("Reservation not found.");

  await updateDoc(doc(db, `roomingListLinks/${token}`), {
    reservations: nextReservations,
    status: "Concept",
    updatedAt: serverTimestamp(),
  });
  await markRoomingListConcept(roomingList);
}
