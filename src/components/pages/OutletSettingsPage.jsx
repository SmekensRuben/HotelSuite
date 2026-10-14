import React from "react";
import { getOutlets } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import ProcurementResourceSettingsSection from "./ProcurementResourceSettingsSection";
import { outletInventoryRoleLabel } from "../inventory/OutletInventoryRoleField";

export default function OutletSettingsPage() {
  const scope = useProcurementSettingsScope();
  const canRead = usePermission("outlets", "read");
  return canRead ? <ProcurementResourceSettingsSection key={scope.scopeKey}
    scope={scope} feature="outlets" singular="Outlet" title="Outlets & approvers"
    description="Count per outlet or central stock point. Add optional locations for detail, receive deliveries centrally and requisition goods to other outlets."
    detailColumns={[{ key: "inventoryRole", label: "Stock point type", render: (outlet) => outletInventoryRoleLabel(outlet.inventoryRole) }]}
    loadRecords={getOutlets} /> : null;
}
