import { useHotelContext } from "../contexts/HotelContext";
import { hasPermission } from "../utils/permissions";

export function usePermission(feature, action) {
  const { permissions, isPlatformAdmin } = useHotelContext();
  return isPlatformAdmin || hasPermission({ permissions }, feature, action);
}
