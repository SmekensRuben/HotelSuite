import { useHotelContext } from "../contexts/HotelContext";
import { hasPermission } from "../utils/permissions";

export function usePermission(feature, action) {
  const { permissions } = useHotelContext();
  return hasPermission({ permissions }, feature, action);
}
