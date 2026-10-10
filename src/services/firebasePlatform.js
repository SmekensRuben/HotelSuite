import { functions, httpsCallable } from "../firebaseConfig";

async function call(name, input = {}) {
  const { data } = await httpsCallable(functions, name, name === "retryPlatformImport" ? { timeout: 540000 } : undefined)(input);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The platform response is invalid.");
  if (input.hotelUid && input.hotelUid !== data.hotelUid) throw new Error("The platform response belongs to another hotel.");
  return data;
}
export const listPlatformUsers = (afterUid = null) => call("listPlatformUsers", { afterUid });
export const listPlatformHotels = (afterHotelUid = null) => call("listPlatformHotels", { afterHotelUid });
export const getPlatformHotel = (hotelUid) => call("getPlatformHotel", { hotelUid });
export const updatePlatformHotel = (input) => call("updatePlatformHotel", input);
export const getPlatformMonitoring = (hotelUid) => call("getPlatformMonitoring", { hotelUid });
export const savePlatformImportMonitor = (input) => call("savePlatformImportMonitor", input);
export const refreshPlatformMonitoring = (hotelUid) => call("refreshPlatformMonitoring", { hotelUid });
export const listPlatformAudit = (afterId = null, hotelUid = null) => call("listPlatformAudit", { afterId, hotelUid });
export const listPlatformIncidents = (afterId = null) => call("listPlatformIncidents", { afterId });
export const acknowledgePlatformIncident = (incidentId, reason) => call("acknowledgePlatformIncident", { incidentId, reason });
export const startPlatformSupport = (hotelUid, reason, requestId) => call("startPlatformSupport", { hotelUid, reason, requestId });
export const getPlatformSupport = (hotelUid, sessionId) => call("getPlatformSupport", { hotelUid, sessionId });
export const endPlatformSupport = (sessionId) => call("endPlatformSupport", { sessionId });
export const retryPlatformImport = (input) => call("retryPlatformImport", input);

export function platformError(error) {
  if (["functions/unauthenticated", "functions/permission-denied"].includes(error?.code)) return "Your current platform access could not be verified. Sign in again.";
  if (error?.code === "functions/aborted") return "Another administrator changed this record. Refresh before saving again.";
  if (["functions/invalid-argument", "functions/failed-precondition", "functions/already-exists", "functions/not-found"].includes(error?.code)) return error.message;
  return "The platform request could not be completed. Check your connection and refresh.";
}
