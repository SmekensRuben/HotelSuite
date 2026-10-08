import { collection, db, functions, getDocs, httpsCallable } from "../firebaseConfig";

export async function getHotelSubscriptions() {
  const [hotels, subscriptions] = await Promise.all([
    getDocs(collection(db, "hotels")), getDocs(collection(db, "hotelSubscriptions")),
  ]);
  const byHotel = new Map(subscriptions.docs.map((snapshot) => [snapshot.id, snapshot.data()]));
  return hotels.docs.map((snapshot) => ({ hotelUid: snapshot.id,
    hotelName: snapshot.data().hotelName || snapshot.id, subscription: byHotel.get(snapshot.id) || null }));
}

export async function saveHotelSubscription(input) {
  return (await httpsCallable(functions, "setHotelSubscription")(input)).data;
}
