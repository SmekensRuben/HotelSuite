import { useHotelContext } from "../contexts/HotelContext";
import { hasPermission } from "../utils/permissions";

export function usePermission(feature, action) {
  const { roles } = useHotelContext();  // let op: haakjes!
  return hasPermission({ roles }, feature, action);
}
