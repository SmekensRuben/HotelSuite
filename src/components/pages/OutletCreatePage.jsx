import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  createOutlet,
  setOutletApprovers,
} from "../../services/firebaseSettings";

export default function OutletCreatePage() {
  const navigate = useNavigate(),
    { hotelUid, scopeKey: settingsScopeKey } = useProcurementSettingsScope();
  const canCreate = usePermission("outlets", "create"),
    canManageApprovers = usePermission("outlets", "approvers");
  const [name, setName] = useState(""),
    [inventoryRole, setInventoryRole] = useState("outlet"),
    [selectedIds, setSelectedIds] = useState([]),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [createdOutlet, setCreatedOutlet] = useState(null);
  const scopeKey = `${settingsScopeKey}:${canCreate}:${canManageApprovers}`;
  const active = useRef({ key: scopeKey, actor: auth.currentUser });
  if (active.current.key !== scopeKey || active.current.actor !== auth.currentUser) active.current = { key: scopeKey, actor: auth.currentUser };
  const loadUsers = useCallback(
    async () =>
      (await listHotelUsers(hotelUid)).filter((user) => user.canApprove),
    [hotelUid],
  );
  const users = useScopedAsync({
    scopeKey,
    enabled: Boolean(hotelUid && canManageApprovers),
    load: loadUsers,
  });
  const recovery = usePendingProcurementResourceMutation({ hotelUid, collection: "outlets", onComplete: (result) => navigate(`/settings/outlets/${result.resourceId}`) });
  useEffect(() => {
    active.current = { key: scopeKey, actor: auth.currentUser };
    setName("");
    setInventoryRole("outlet");
    setSelectedIds([]);
    setSaving(false);
    setError("");
    setCreatedOutlet(null);
    return () => {
      active.current = { key: null };
    };
  }, [scopeKey]);
  const submit = async (event) => {
    event.preventDefault();
    if (
      !canCreate ||
      !hotelUid ||
      auth.currentUser !== active.current.actor ||
      !name.trim() ||
      saving ||
      recovery.blocked ||
      (canManageApprovers && (users.loading || users.error))
    )
      return;
    const requested = active.current;
    setSaving(true);
    setError("");
    try {
      const outlet =
        createdOutlet ||
        (await createOutlet(hotelUid, {
          name: name.trim(),
          inventoryRole,
          createdBy: auth.currentUser?.uid || null,
        }));
      if (active.current !== requested || auth.currentUser !== requested.actor) return;
      setCreatedOutlet(outlet);
      if (canManageApprovers)
        await setOutletApprovers(
          hotelUid,
          outlet.id,
          (users.data || []).filter((user) => selectedIds.includes(user.id)),
        );
      if (active.current === requested && auth.currentUser === requested.actor) navigate("/settings/outlets");
    } catch (failure) {
      if (active.current === requested && auth.currentUser === requested.actor) {
        setError(failure.message || "Unable to save the outlet.");
        recovery.refresh();
      }
    } finally {
      if (active.current === requested && auth.currentUser === requested.actor) setSaving(false);
    }
  };
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
          <h1 className="mt-1 text-3xl font-semibold">Add Outlet</h1>
          <p className="mt-2 text-sm text-gray-600">
            Create an outlet or central stock point for purchasing and counting.
            Locations and order approvers can be added when needed.
          </p>
        </div>
        <PendingProcurementResourceMutation recovery={recovery} noun="outlet" disabled={saving} />
        <Card>
          <form onSubmit={submit} className="space-y-5">
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
                disabled={Boolean(createdOutlet) || saving || !canCreate || recovery.blocked}
                onChange={(event) => setName(event.target.value)}
                placeholder="Outlet name"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                required
              />
            </div>
            <OutletInventoryRoleField value={inventoryRole} onChange={setInventoryRole} disabled={Boolean(createdOutlet) || saving || !canCreate || recovery.blocked} />
            {canManageApprovers && (
              <>
                <OutletApproverPicker
                  users={users.data || []}
                  selectedIds={selectedIds}
                  onChange={setSelectedIds}
                  disabled={saving || recovery.blocked || users.loading || Boolean(users.error)}
                  loading={users.loading}
                />
                {users.error && (
                  <div role="alert" className="text-sm text-red-700">
                    <p>
                      Hotel approvers could not be loaded. No approver changes
                      have been made.
                    </p>
                    <button
                      type="button"
                      onClick={users.retry}
                      className="underline"
                    >
                      Retry approvers
                    </button>
                  </div>
                )}
              </>
            )}
            {createdOutlet && (
              <p className="text-sm text-amber-800">
                The outlet was created. Retry saving to finish its approver
                configuration.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2 border-t border-gray-100 pt-4">
              <button
                type="button"
                onClick={() => navigate("/settings/outlets")}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  !canCreate ||
                  !hotelUid ||
                  auth.currentUser !== active.current.actor ||
                  saving ||
                  recovery.blocked ||
                  !name.trim() ||
                  (canManageApprovers &&
                    (users.loading || Boolean(users.error)))
                }
                className="rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Outlet"}
              </button>
            </div>
          </form>
        </Card>
      </ProcurementPage>
    </div>
  );
}
