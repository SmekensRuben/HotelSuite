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

function buildPublicLink(token) {
  const origin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";
  return `${origin}/rooming-list/${token}`;
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
  const nextReservation = {
    id: createAccessToken().slice(0, 16),
    firstName: String(reservation.firstName || "").trim(),
    lastName: String(reservation.lastName || "").trim(),
    arrivalDate: String(reservation.arrivalDate || "").trim(),
    departureDate: String(reservation.departureDate || "").trim(),
    roomType: String(reservation.roomType || "").trim(),
    numberOfAdults: Math.max(0, Number(reservation.numberOfAdults || 0)),
    numberOfChildren: Math.max(0, Number(reservation.numberOfChildren || 0)),
    comment: String(reservation.comment || "").trim(),
    createdAt: new Date().toISOString(),
  };
  const nextReservations = [...reservations, nextReservation];

  await updateDoc(doc(db, `roomingListLinks/${token}`), {
    reservations: nextReservations,
    status: "Concept",
    updatedAt: serverTimestamp(),
  });

  if (roomingList.hotelUid && roomingList.groupId) {
    await updateDoc(doc(db, `hotels/${roomingList.hotelUid}/groups/${roomingList.groupId}`), {
      roomingListStatus: "Concept",
      updatedAt: serverTimestamp(),
    });
  }

  return nextReservation;
}
