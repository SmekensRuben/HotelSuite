import React, { useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pencil } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import ProcurementResourceArchive from "./ProcurementResourceArchive";
import { auth, signOut } from "../../firebaseConfig";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import {
  getOutletApprovers,
  getOutletById,
} from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { outletInventoryRoleLabel } from "../inventory/OutletInventoryRoleField";

export default function OutletDetailPage() {
  const navigate = useNavigate(),
    { outletId } = useParams(),
    { hotelUid, scopeKey: settingsScopeKey } = useProcurementSettingsScope();
  const canEdit = usePermission("outlets", "update");
  const canCount = usePermission("stockcounts", "create");
  const canRequisition = usePermission("inventorymovements", "create");
  const canAddLocation = usePermission("locations", "create");
  const load = useCallback(async () => {
    const [outlet, approvers] = await Promise.all([
      getOutletById(hotelUid, outletId),
      getOutletApprovers(hotelUid, outletId),
    ]);
    return { outlet, approvers };
  }, [hotelUid, outletId]);
  const query = useScopedAsync({
    scopeKey: `${settingsScopeKey}:${outletId}`,
    enabled: Boolean(hotelUid && outletId),
    load,
  });
  const outlet = query.data?.outlet;
  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar
        today={new Date().toLocaleDateString()}
        onLogout={async () => {
          await signOut(auth);
          sessionStorage.clear();
          window.location.href = "/login";
        }}
      />
      <ProcurementPage className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
              Purchasing &amp; Inventory · Settings
            </p>
            <h1 className="mt-1 text-3xl font-semibold">Outlet Detail</h1>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => navigate("/settings/outlets")}
              aria-label="Back to outlets"
              className="rounded-lg border border-gray-300 p-2 text-gray-700"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => navigate(`/settings/outlets/${outletId}/edit`)}
              disabled={!canEdit || !outlet || outlet.archived === true}
              aria-label="Edit outlet"
              className="rounded-lg border border-gray-300 p-2 text-gray-700 disabled:opacity-50"
            >
              <Pencil className="h-4 w-4" />
            </button>
          </div>
        </div>
        {query.loading ? (
          <p className="text-sm text-gray-600">Loading outlet...</p>
        ) : query.error ? (
          <div role="alert" className="text-sm text-red-700">
            <p>{query.error.message || "Unable to load outlet."}</p>
            <button type="button" onClick={query.retry} className="underline">
              Retry outlet
            </button>
          </div>
        ) : !outlet ? (
          <Card>Outlet not found.</Card>
        ) : (
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <Card className="space-y-4">
              <div>
                <h2 className="text-2xl font-semibold">
                  {outlet.name || "Unnamed outlet"}
                </h2>
                <p className="mt-2 text-xs font-semibold text-brand-800">{outletInventoryRoleLabel(outlet.inventoryRole)}</p>
                <p className="mt-2 text-sm text-gray-600">
                  {outlet.inventoryRole === "central_storage" ? "Receive deliveries at this stock point and record requisitions when goods move to another outlet. " : "Count this outlet as a whole, or use optional locations for more detail. "}
                  Orders use this outlet for purchasing and approval.
                </p>
                {outlet.archived !== true && <div className="mt-4 flex flex-wrap gap-2">
                  {canCount && <button type="button" className="ht-button-primary" onClick={() => navigate(`/catalog/stock-counts/new?outletId=${encodeURIComponent(outletId)}`)}>Start stock count</button>}
                  {canRequisition && outlet.inventoryRole === "central_storage" && <button type="button" className="ht-button-secondary" onClick={() => navigate(`/catalog/inventory-movements?type=requisition&sourceOutletId=${encodeURIComponent(outletId)}`)}>Record requisition</button>}
                  {canAddLocation && <button type="button" className="ht-button-secondary" onClick={() => navigate(`/settings/locations/new?outletId=${encodeURIComponent(outletId)}`)}>Add optional location</button>}
                </div>}
              </div>
              <ProcurementResourceArchive
                hotelUid={hotelUid}
                collection="outlets"
                resource={outlet}
                onArchived={() => navigate("/settings/outlets")}
              />
            </Card>
            <Card>
              <h2 className="mb-3 text-xl font-semibold">Approvers</h2>
              {query.data.approvers.length === 0 ? (
                <p className="text-sm text-gray-600">
                  No approvers configured.
                </p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {query.data.approvers.map((approver) => {
                    const fullName =
                      `${approver.firstName || ""} ${approver.lastName || ""}`.trim();
                    return (
                      <li key={approver.id} className="py-3">
                        <p className="text-sm font-medium text-gray-800">
                          {fullName ||
                            approver.displayName ||
                            approver.email ||
                            "Name unavailable"}
                        </p>
                        {fullName && approver.email && (
                          <p className="mt-1 text-xs text-gray-500">
                            {approver.email}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>
        )}
      </ProcurementPage>
    </div>
  );
}
