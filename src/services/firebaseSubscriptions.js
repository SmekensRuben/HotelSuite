import { functions, httpsCallable, Timestamp } from "../firebaseConfig";

export async function getHotelSubscriptions() {
  const list = httpsCallable(functions, "listHotelSubscriptions");
  const hotels = [];
  const cursors = new Set();
  let afterHotelUid = null;
  do {
    const { data } = await list({ afterHotelUid });
    if (!Array.isArray(data?.hotels) || (data.nextCursor !== null && typeof data.nextCursor !== "string")) {
      throw new Error("The subscription overview response is invalid.");
    }
    hotels.push(...data.hotels.map(({ subscription, ...hotel }) => {
      if (subscription === null) return { ...hotel, subscription: null };
      const { validUntilMillis, ...fields } = subscription;
      if (!Number.isSafeInteger(fields.revision) || fields.revision < 0
        || (validUntilMillis !== null && !Number.isFinite(validUntilMillis))) {
        throw new Error("The subscription overview record is invalid.");
      }
      return { ...hotel, subscription: { ...fields,
        validUntil: validUntilMillis === null ? null : Timestamp.fromMillis(validUntilMillis) } };
    }));
    afterHotelUid = data.nextCursor;
    if (afterHotelUid !== null && (cursors.has(afterHotelUid) || data.hotels.length === 0)) {
      throw new Error("The subscription overview cursor is invalid.");
    }
    cursors.add(afterHotelUid);
  } while (afterHotelUid !== null);
  return hotels;
}

export async function saveHotelSubscription(input) {
  return (await httpsCallable(functions, "setHotelSubscription")(input)).data;
}
