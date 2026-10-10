import { functions, httpsCallable } from "../firebaseConfig";

export async function getAllUsers() {
  const result = await httpsCallable(functions, "listPlatformUsers")({});
  return result.data.users;
}
export async function getUserById(userId) {
  if (!userId) throw new Error("userId is required");
  return (await httpsCallable(functions, "getPlatformUserAccess")({ userId })).data.user;
}
export async function getUserMemberships(userId, hotelUids) {
  if (!userId) throw new Error("userId is required");
  const result = (await httpsCallable(functions, "getPlatformUserAccess")({ userId })).data.memberships;
  return Object.fromEntries((hotelUids || []).map((id) => [id, result[id] || []]));
}

export async function updateUserWithMemberships(userId, profile, memberships, expectedAccessRevision = 0) {
  if (!userId) throw new Error("userId is required");
  const updateAccess = httpsCallable(functions, "updateUserAccess");
  const result = await updateAccess({ userId, profile, memberships, expectedAccessRevision });
  return result.data;
}

export async function getHotelUserDisplayName(hotelUid, userId) {
  if (!hotelUid) throw new Error("hotelUid is required");
  if (!userId) return "-";
  const result = await httpsCallable(functions, "getHotelUserDisplayName")({ hotelUid, userId });
  return result.data.displayName || String(userId);
}
