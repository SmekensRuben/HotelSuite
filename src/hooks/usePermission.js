import { useHotelContext } from "../contexts/HotelContext";
import { hasPermission } from "../utils/permissions";
import { featureIsLicensed } from "../constants/moduleCatalog";

export function usePermission(feature, action) {
  const { permissions, isPlatformAdmin, subscriptionActive, subscription } = useHotelContext();
  return isPlatformAdmin || (subscriptionActive === true && featureIsLicensed(subscription, feature)
    && hasPermission({ permissions }, feature, action));
}
