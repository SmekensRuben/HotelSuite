import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import OutletApproverPicker from "./OutletApproverPicker";
import OutletInventoryRoleField from "../inventory/OutletInventoryRoleField";
import PendingProcurementResourceMutation, { usePendingProcurementResourceMutation } from "../inventory/PendingProcurementResourceMutation";
import { auth, signOut } from "../../firebaseConfig";
import { usePermission } from "../../hooks/usePermission";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { listHotelUsers } from "../../services/firebaseOnboarding";
import {
  getOutletApprovers,
  getOutletById,
  setOutletApprovers,
  updateOutlet,
} from "../../services/firebaseSettings";

export default function OutletEditPage() {
  const navigate = useNavigate(),
    { outletId } = useParams(),
    { hotelUid, scopeKey: settingsScopeKey } = useProcurementSettingsScope();
  const canUpdate = usePermission("outlets", "update"),
    canManageApprovers = usePermission("outlets", "approvers");
  const [name, setName] = useState(""),
    [inventoryRole, setInventoryRole] = useState("outlet"),
    [resourceSaved, setResourceSaved] = useState(false),
    [selectedIds, setSelectedIds] = useState([]),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const scopeKey = `${settingsScopeKey}:${outletId}:${canUpdate}:${canManageApprovers}`;
  const active = useRef({ key: scopeKey, actor: auth.currentUser });
  if (active.current.key !== scopeKey || active.current.actor !== auth.currentUser) active.current = { key: scopeKey, actor: auth.currentUser };
  const load = useCallback(async () => {
    const [outlet, users, approvers] = await Promise.all([
      getOutletById(hotelUid, outletId),
      canManageApprovers ? listHotelUsers(hotelUid) : [],
      canManageApprovers ? getOutletApprovers(hotelUid, outletId) : [],
    ]);
    return {
      outlet,
      users: users.filter((user) => user.canApprove),
      approvers,
    };
  }, [hotelUid, outletId, canManageApprovers]);
  const query = useScopedAsync({
    scopeKey,
    enabled: Boolean(hotelUid && outletId),
    load,
  });
  useEffect(() => {
    active.current = { key: scopeKey, actor: auth.currentUser };
    setName("");
    setInventoryRole("outlet");
    setResourceSaved(false);
    setSelectedIds([]);
    setSaving(false);
    setError("");
    return () => {
      active.current = { key: null };
    };
  }, [scopeKey]);
  useEffect(() => {
    if (query.data) {
      setName(query.data.outlet?.name || "");
      setInventoryRole(query.data.outlet?.inventoryRole === "central_storage" ? "central_storage" : "outlet");
      setSelectedIds(query.data.approvers.map((user) => user.id));
    }
  }, [query.data]);
  const outlet = query.data?.outlet;
  const recovery = usePendingProcurementResourceMutation({ hotelUid, collection: "outlets", resourceId: outletId, onComplete: () => navigate(`/settings/outlets/${outletId}`) });
  const submit = async (event) => {
    event.preventDefault();
    if (
      !canUpdate ||
      !hotelUid ||
      auth.currentUser !== active.current.actor ||
      !outletId ||
      !name.trim() ||
      saving ||
      recovery.blocked ||
      !outlet ||
      outlet.archived === true
    )
      return;
    const requested = active.current;
    setSaving(true);
    setError("");
    try {
      if (!resourceSaved) await updateOutlet(hotelUid, outletId, {
          name: name.trim(),
          inventoryRole,
          expectedRevision: outlet.revision ?? 0,
          updatedBy: auth.currentUser?.uid || null,
        });
      if (active.current !== requested || auth.currentUser !== requested.actor) return;
      setResourceSaved(true);
      if (canManageApprovers)
        await setOutletApprovers(
          hotelUid,
          outletId,
          query.data.users.filter((user) => selectedIds.includes(user.id)),
        );
      if (active.current === requested && auth.currentUser === requested.actor)
        navigate(`/settings/outlets/${outletId}`);
    } catch (failure) {
      if (active.current === requested && auth.currentUser === requested.actor) {
        setError(failure.message || "Unable to save the outlet.");
        recovery.refresh();
      }
    } finally {
      if (active.current === requested && auth.currentUser === requested.actor) setSaving(false);
    }
  };
  const disabled =
    !canUpdate ||
    saving ||
    recovery.blocked ||
    query.loading ||
    Boolean(query.error) ||
    !outlet ||
    outlet.archived === true;
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
      <ProcurementPage width="form" className="space-y-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
            Purchasing &amp; Inventory · Settings
          </p>
          <h1 className="mt-1 text-3xl font-semibold">Edit Outlet</h1>
        </div>
        <PendingProcurementResourceMutation recovery={recovery} noun="outlet" disabled={saving} />
        {query.loading ? (
          <p>Loading outlet and approvers...</p>
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
          <Card>
            <form onSubmit={submit} className="space-y-5">
              {outlet.archived === true && (
                <p className="text-sm text-amber-800">
                  This outlet is archived and cannot be edited.
                </p>
              )}
              <div>
                <label
                  htmlFor="outlet-name"
                  className="mb-2 block text-sm font-medium text-gray-700"
                >
                  Name
                </label>
                <input
                  id="outlet-name"
                  maxLength={200}
                  value={name}
                  disabled={disabled || resourceSaved}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Outlet name"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  required
                />
              </div>
              <OutletInventoryRoleField value={inventoryRole} onChange={setInventoryRole} disabled={disabled || resourceSaved} />
              {canManageApprovers && (
                <OutletApproverPicker
                  users={query.data.users}
                  selectedIds={selectedIds}
                  onChange={setSelectedIds}
                  disabled={disabled}
                />
              )}
              {error && (
                <p role="alert" className="text-sm text-red-700">
                  {error}
                </p>
              )}
              {resourceSaved && error && canManageApprovers && <p className="text-sm text-amber-800">Outlet settings were saved. Retry saving to finish the approver configuration.</p>}
              <div className="flex justify-end gap-2 border-t border-gray-100 pt-4">
                <button
                  type="button"
                  onClick={() => navigate(`/settings/outlets/${outletId}`)}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={disabled || !name.trim()}
                  className="rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save Outlet"}
                </button>
              </div>
            </form>
          </Card>
        )}
      </ProcurementPage>
    </div>
  );
}
