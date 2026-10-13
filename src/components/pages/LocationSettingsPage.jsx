import React from "react";
import { getLocations } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import ProcurementResourceSettingsSection from "./ProcurementResourceSettingsSection";

export default function LocationSettingsPage() {
  const scope = useProcurementSettingsScope();
  const canRead = usePermission("locations", "read");
  return canRead ? <ProcurementResourceSettingsSection key={scope.scopeKey}
    scope={scope} feature="locations" singular="Location" title="Locations & stock templates"
    description="Manage physical storage locations and the templates used to count their catalog articles." loadRecords={getLocations} /> : null;
}
