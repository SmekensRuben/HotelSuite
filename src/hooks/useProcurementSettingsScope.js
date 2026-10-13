import { useCallback, useRef } from "react";
import { auth } from "../firebaseConfig";
import { useHotelContext } from "../contexts/HotelContext";

const identities = new WeakMap();
let nextIdentity = 0;

/** Reset settings drafts and reads when either the hotel or access identity changes. */
export function useProcurementSettingsScope() {
  const context = useHotelContext();
  const actor = auth.currentUser;
  if (actor && !identities.has(actor)) identities.set(actor, ++nextIdentity);
  const scopeKey = JSON.stringify([
    context.hotelUid,
    actor ? identities.get(actor) : null,
    actor?.uid,
    context.permissions,
    context.permissionsLoading,
    context.subscription,
    context.subscriptionActive,
    context.subscriptionLoading,
    context.authorizationSource,
  ]);
  const latest = useRef(scopeKey);
  latest.current = scopeKey;
  const current = useCallback(() => latest.current === scopeKey && auth.currentUser === actor, [scopeKey, actor]);
  return {
    hotelUid: context.hotelUid,
    scopeKey,
    current,
  };
}
