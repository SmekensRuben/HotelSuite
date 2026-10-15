import { functions, httpsCallable } from "../firebaseConfig";
import { procurementReadScope } from "./procurementReadPool";

async function call(name, hotelUid, input) {
  const scope = procurementReadScope(hotelUid);
  if (!scope) throw new Error("Sign in to view purchase request notifications.");
  const result = (await httpsCallable(functions, name)({ ...input, hotelUid })).data;
  if (!scope.current()) throw new Error("Your hotel access changed. Reopen the purchase request.");
  return result;
}

export async function getPurchaseRequestNotifications(hotelUid, purchaseRequestId) {
  if (!hotelUid || !purchaseRequestId) return { notifications: [] };
  return call("readHotelPurchaseRequestNotifications", hotelUid, { purchaseRequestId });
}

export async function retryPurchaseRequestNotification(hotelUid, mailId) {
  if (!hotelUid || !mailId) throw new Error("Choose a notification from this hotel.");
  return call("retryPurchaseRequestNotification", hotelUid, { mailId });
}
