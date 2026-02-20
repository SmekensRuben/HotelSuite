import { useHotelContext } from "../contexts/HotelContext";
import { hasPermission } from "../utils/permissions";

export function usePermission(feature, action) {
  const { roles, rolePermissions } = useHotelContext();
  return hasPermission({ roles }, feature, action, rolePermissions);
}
