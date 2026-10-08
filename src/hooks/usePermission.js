import { useHotelContext } from "../contexts/HotelContext";
import { hasPermission } from "../utils/permissions";

export function usePermission(feature, action) {
  const { permissions, isPlatformAdmin, subscriptionActive } = useHotelContext();
  return isPlatformAdmin || (subscriptionActive === true && hasPermission({ permissions }, feature, action));
}
