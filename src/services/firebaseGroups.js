import {
  db,
  collection,
  doc,
  getDocs,
  setDoc,
  serverTimestamp,
} from "../firebaseConfig";

function normalizeDateInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function sanitizeRoomTypeDays(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((day) => {
      const date = normalizeDateInput(day?.date);
      const roomTypes = Array.isArray(day?.roomTypes)
        ? day.roomTypes
            .map((roomType) => {
              const quantity = Number(roomType?.quantity);
              return {
                name: String(roomType?.name || "").trim(),
                quantity: Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0,
              };
            })
            .filter((roomType) => roomType.name || roomType.quantity > 0)
        : [];

      return { date, roomTypes };
    })
    .filter((day) => day.date && day.roomTypes.length > 0);
}

export function calculateBlockedRooms(roomTypeDays) {
  return sanitizeRoomTypeDays(roomTypeDays).reduce(
    (total, day) => total + day.roomTypes.reduce((dayTotal, roomType) => dayTotal + roomType.quantity, 0),
    0
  );
}

function buildGroupPayload(groupData, actor) {
  const roomTypeDays = sanitizeRoomTypeDays(groupData.roomTypeDays);

  return {
    groupName: String(groupData.groupName || "").trim(),
    blockCode: String(groupData.blockCode || "").trim(),
    arrival: normalizeDateInput(groupData.arrival),
    departure: normalizeDateInput(groupData.departure),
    roomingListDeadline: normalizeDateInput(groupData.roomingListDeadline),
    blockedRooms: calculateBlockedRooms(roomTypeDays),
    meOfficer: String(groupData.meOfficer || "").trim(),
    organiserName: String(groupData.organiserName || "").trim(),
    organiserEmail: String(groupData.organiserEmail || "").trim(),
    organiserPhone: String(groupData.organiserPhone || "").trim(),
    roomTypeDays,
    updatedAt: serverTimestamp(),
    updatedBy: actor || "unknown",
  };
}

export async function getGroups(hotelUid) {
  if (!hotelUid) return [];
  const groupsCol = collection(db, `hotels/${hotelUid}/groups`);
  const snap = await getDocs(groupsCol);
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

export async function createGroup(hotelUid, groupData, actor) {
  if (!hotelUid) throw new Error("hotelUid is required");

  const groupsCol = collection(db, `hotels/${hotelUid}/groups`);
  const groupDocRef = doc(groupsCol);
  const payload = {
    ...buildGroupPayload(groupData, actor),
    createdAt: serverTimestamp(),
    createdBy: actor || "unknown",
  };

  await setDoc(groupDocRef, payload);
  return groupDocRef.id;
}
