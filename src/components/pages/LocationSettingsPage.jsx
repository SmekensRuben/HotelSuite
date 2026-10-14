import React, { useCallback } from "react";
import { getLocations, getOutlets } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import ProcurementResourceSettingsSection from "./ProcurementResourceSettingsSection";

export default function LocationSettingsPage() {
  const scope = useProcurementSettingsScope();
  const canRead = usePermission("locations", "read");
  const canReadOutlets = usePermission("outlets", "read");
  const loadRecords = useCallback(async (hotelUid, options) => {
    const [locations, outlets] = await Promise.allSettled([
      getLocations(hotelUid, options),
      canReadOutlets ? getOutlets(hotelUid, { includeArchived: true }) : Promise.resolve([]),
    ]);
    if (locations.status === "rejected") throw locations.reason;
    const outletNames = new Map((outlets.status === "fulfilled" ? outlets.value : []).map((outlet) => [outlet.id, `${outlet.name}${outlet.archived === true ? " (archived)" : ""}`]));
    return locations.value.filter((location) => location.stockPointType !== "outlet" && !String(location.id || "").startsWith("outlet:"))
      .map((location) => ({ ...location, outletName: location.outletId ? outletNames.get(location.outletId) || "Outlet unavailable" : "Unassigned" }));
  }, [canReadOutlets]);
  return canRead ? <ProcurementResourceSettingsSection key={scope.scopeKey}
    scope={scope} feature="locations" singular="Location" title="Locations & stock templates"
    description="Add optional areas within an outlet when more detail helps. Outlets can be counted directly, and stock templates are optional."
    loadRecords={loadRecords} detailColumns={canReadOutlets ? [{ key: "outletName", label: "Outlet" }] : []} /> : null;
}
