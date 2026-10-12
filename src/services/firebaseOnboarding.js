import { functions, httpsCallable } from "../firebaseConfig";

export async function getHotelOnboardingStatus() {
  return (await httpsCallable(functions, "getHotelOnboardingStatus")({})).data;
}

export async function getHotelSetupReadiness(hotelUid) {
  const { data } = await httpsCallable(functions, "getHotelSetupReadiness")({ hotelUid });
  const states = ["ready", "blocked", "incomplete", "unknown"];
  const checkStates = ["ready", "blocked", "pending", "unknown", "not-applicable"];
  if (!data || data.hotelUid !== hotelUid || data.schemaVersion !== 1 || !states.includes(data.status)
    || !Number.isFinite(data.computedAtMillis) || !Array.isArray(data.checks) || !data.checks.length
    || data.checks.some((check) => !check || typeof check.id !== "string" || typeof check.label !== "string"
      || typeof check.detail !== "string" || !checkStates.includes(check.status) || typeof check.required !== "boolean")
    || !data.integrity || !Array.isArray(data.integrity.issues) || data.integrity.issues.length > 100
    || !Number.isSafeInteger(data.integrity.issueCount) || data.integrity.issueCount < 0
    || typeof data.integrity.inspectionTruncated !== "boolean" || typeof data.integrity.issuesTruncated !== "boolean"
    || data.integrity.issues.some((issue) => !issue || typeof issue.uid !== "string" || !Array.isArray(issue.codes) || !issue.codes.length || issue.codes.some((code) => typeof code !== "string"))
    || !Array.isArray(data.recentInvitations) || data.recentInvitations.length > 10
    || data.status === "ready" && (data.integrity.issueCount > 0 || data.integrity.inspectionTruncated || data.checks.some((check) => check.required && !["ready", "not-applicable"].includes(check.status)))) {
    throw new Error("The hotel readiness response is incomplete or belongs to another hotel.");
  }
  return data;
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
