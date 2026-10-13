import React from "react";
import { getOutlets } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import ProcurementResourceSettingsSection from "./ProcurementResourceSettingsSection";

export default function OutletSettingsPage() {
  const scope = useProcurementSettingsScope();
  const canRead = usePermission("outlets", "read");
  return canRead ? <ProcurementResourceSettingsSection key={scope.scopeKey}
    scope={scope} feature="outlets" singular="Outlet" title="Outlets & approvers"
    description="Manage purchasing outlets, order approval and delivery responsibilities." loadRecords={getOutlets} /> : null;
}
