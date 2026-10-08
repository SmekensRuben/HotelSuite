import { collection, db, functions, getDocs, httpsCallable } from "../firebaseConfig";

export async function getHotelSubscriptions() {
  const hotels = await getDocs(collection(db, "hotels"));
  const hotelRecords = hotels.docs.map((snapshot) => ({ hotelUid: snapshot.id,
    hotelName: snapshot.data().hotelName || snapshot.data().name || snapshot.id }));
  let subscriptions;
  try {
    subscriptions = await getDocs(collection(db, "hotelSubscriptions"));
  } catch (cause) {
    const error = new Error("Subscription records could not be loaded.", { cause });
    error.code = cause.code;
    error.hotelRecords = hotelRecords;
    throw error;
  }
  const byHotel = new Map(subscriptions.docs.map((snapshot) => [snapshot.id, snapshot.data()]));
  return hotelRecords.map((hotel) => ({ ...hotel, subscription: byHotel.get(hotel.hotelUid) || null }));
}

export async function saveHotelSubscription(input) {
  return (await httpsCallable(functions, "setHotelSubscription")(input)).data;
}
