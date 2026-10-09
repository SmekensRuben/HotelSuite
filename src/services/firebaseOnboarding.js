import { functions, httpsCallable } from "../firebaseConfig";

export async function getHotelOnboardingStatus() {
  return (await httpsCallable(functions, "getHotelOnboardingStatus")({})).data;
}

export async function createHotel(input) {
  return (await httpsCallable(functions, "createHotel")(input)).data;
}
export async function inviteHotelUser(input) {
  return (await httpsCallable(functions, "inviteHotelUser")(input)).data;
}
export async function listHotelUsers(hotelUid) {
  const users = [];
  const seen = new Set();
  let afterUid = null;
  do {
    const { data } = await httpsCallable(functions, "listHotelUsers")({ hotelUid, afterUid });
    users.push(...data.users);
    afterUid = data.nextCursor;
    if (afterUid && seen.has(afterUid)) throw new Error("Invalid hotel user page cursor.");
    seen.add(afterUid);
  } while (afterUid);
  return users;
}
