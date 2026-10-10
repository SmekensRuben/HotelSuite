import { functions, httpsCallable } from "../firebaseConfig";

export async function getHotelTeam(hotelUid) {
  const users = [];
  const cursors = new Set();
  let afterUid = null;
  let settings;
  do {
    const { data } = await httpsCallable(functions, "listHotelTeam")({ hotelUid, afterUid });
    if (!Array.isArray(data?.users) || !Array.isArray(data.modules)
      || (data.nextCursor !== null && typeof data.nextCursor !== "string")) throw new Error("Hotel team response is invalid.");
    users.push(...data.users);
    settings = { modules: data.modules, seatLimit: data.seatLimit };
    afterUid = data.nextCursor;
    if (afterUid !== null && (cursors.has(afterUid) || !data.users.length)) throw new Error("Hotel team cursor is invalid.");
    cursors.add(afterUid);
  } while (afterUid !== null);
  return { users, ...settings };
}
export async function updateHotelMember(input) {
  return (await httpsCallable(functions, "updateHotelMember")(input)).data;
}
export async function removeHotelMember(input) {
  return (await httpsCallable(functions, "removeHotelMember")(input)).data;
}
