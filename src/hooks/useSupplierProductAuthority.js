import { useRef } from "react";
import { auth } from "../firebaseConfig";
import { useHotelContext } from "../contexts/HotelContext";

// A reauthenticated Firebase User can have the same UID and different authority.
export function useSupplierProductAuthority() {
  const { hotelUid, permissions, subscription, subscriptionActive } = useHotelContext();
  const actor = auth.currentUser;
  const session = useRef({ actor, generation: 0 });
  if (session.current.actor !== actor) session.current = { actor, generation: session.current.generation + 1 };
  return JSON.stringify([hotelUid, actor?.uid || null, session.current.generation, permissions || [], subscriptionActive === true, subscription || null]);
}
