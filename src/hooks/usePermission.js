import { useHotelContext } from "../contexts/HotelContext";
import { hasPermission } from "../utils/permissions";
import { featureIsLicensed } from "../constants/moduleCatalog";

export function usePermission(feature, action) {
  const { permissions, subscriptionActive, subscription } = useHotelContext();
  return subscriptionActive === true && featureIsLicensed(subscription, feature)
    && hasPermission({ permissions }, feature, action);
}
