import { functions, httpsCallable } from "../firebaseConfig";
import { invalidateProcurementReads, poolProcurementRead, procurementReadScope } from "./procurementReadPool";

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
  invalidateProcurementReads();
  return result.data;
}

const staffBatches = new Map();
export const UNKNOWN_HOTEL_USER = "Unknown hotel user";

/** Only the server's scoped display-name projection is used; global users are never enumerated. */
export async function getHotelUserDisplayNames(hotelUid, userIds, options = {}) {
  if (!hotelUid) throw new Error("hotelUid is required");
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).filter((id) => typeof id === "string" && id))];
  if (ids.length > 1000) throw new Error("More than 1,000 staff labels require a narrower view.");
  if (!ids.length) return {};
  return poolProcurementRead(hotelUid, `staff:${JSON.stringify([...ids].sort())}`, async () => {
    const names = Object.create(null);
    const batches = [];
    for (let offset = 0; offset < ids.length; offset += 100) batches.push(ids.slice(offset, offset + 100));
    const responses = await Promise.all(batches.map(async (userIds) => {
      const { data } = await httpsCallable(functions, "getHotelUserDisplayNames")({ hotelUid, userIds });
      if (data?.hotelUid !== hotelUid || !Array.isArray(data.users) || data.users.length !== userIds.length) throw new Error("Staff name response scope is invalid.");
      const expected = new Set(userIds);
      for (const user of data.users) {
        if (!expected.delete(user?.userId) || (user.displayName !== null && typeof user.displayName !== "string")) throw new Error("Staff name response is invalid.");
      }
      if (expected.size) throw new Error("Staff name response is incomplete.");
      return data.users;
    }));
    for (const users of responses) for (const user of users) {
      const name = user.displayName?.trim();
      names[user.userId] = name && name !== user.userId ? name : UNKNOWN_HOTEL_USER;
    }
    return names;
  }, options.scopeKey);
}

export async function getHotelUserDisplayName(hotelUid, userId, options = {}) {
  if (!hotelUid) throw new Error("hotelUid is required");
  if (!userId) return "-";
  return poolProcurementRead(hotelUid, `staff-label:${userId}`, () => new Promise((resolve, reject) => {
    const scope = procurementReadScope(hotelUid, options.scopeKey);
    const key = scope?.key || `${hotelUid}:anonymous`;
    let batch = staffBatches.get(key);
    if (!batch) {
      batch = { hotelUid, scope, entries: [] };
      staffBatches.set(key, batch);
      queueMicrotask(async () => {
        staffBatches.delete(key);
        try {
          if (scope && !scope.current()) throw new Error("Hotel access changed while loading. Reload this view.");
          const names = await getHotelUserDisplayNames(hotelUid, batch.entries.map((entry) => entry.userId), options);
          for (const entry of batch.entries) entry.resolve(names[entry.userId] || UNKNOWN_HOTEL_USER);
        } catch (error) {
          for (const entry of batch.entries) entry.reject(error);
        }
      });
    }
    batch.entries.push({ userId, resolve, reject });
  }), options.scopeKey);
}
