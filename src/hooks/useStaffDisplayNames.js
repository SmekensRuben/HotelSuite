import { useCallback } from "react";
import { getHotelUserDisplayName } from "../services/firebaseUserManagement";
import { useScopedAsync } from "./useScopedAsync";

/** Optional staff labels never block the operational record or invent profile access. */
export function useStaffDisplayNames({ hotelUid, scopeKey, record }) {
  const createdBy = record?.createdBy || "";
  const updatedBy = record?.updatedBy || "";
  const createdFallback = record?.createdByName || createdBy || "-";
  const updatedFallback = record?.updatedByName || updatedBy || "-";
  const load = useCallback(async () => {
    const names = await Promise.allSettled([createdBy, updatedBy].map((id) => id ? getHotelUserDisplayName(hotelUid, id) : Promise.resolve("-")));
    return {
      createdByName: names[0].status === "fulfilled" ? names[0].value : createdFallback,
      updatedByName: names[1].status === "fulfilled" ? names[1].value : updatedFallback,
    };
  }, [hotelUid, createdBy, updatedBy, createdFallback, updatedFallback]);
  const query = useScopedAsync({ scopeKey: `${scopeKey}:${createdBy}:${updatedBy}`, enabled: Boolean(hotelUid && record), load });
  return { createdByName: query.data?.createdByName || createdFallback, updatedByName: query.data?.updatedByName || updatedFallback };
}
