import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import OutletApproverPicker from "./OutletApproverPicker";
import { auth, signOut } from "../../firebaseConfig";
import { usePermission } from "../../hooks/usePermission";
import { useHotelContext } from "../../contexts/HotelContext";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { listHotelUsers } from "../../services/firebaseOnboarding";
import {
  createOutlet,
  setOutletApprovers,
} from "../../services/firebaseSettings";

export default function OutletCreatePage() {
  const navigate = useNavigate(),
    { hotelUid } = useHotelContext();
  const canCreate = usePermission("outlets", "create"),
    canManageApprovers = usePermission("outlets", "approvers");
  const [name, setName] = useState(""),
    [selectedIds, setSelectedIds] = useState([]),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [createdOutlet, setCreatedOutlet] = useState(null);
  const scopeKey = `${hotelUid}:${canManageApprovers}`;
  const active = useRef({ key: scopeKey });
  if (active.current.key !== scopeKey) active.current = { key: scopeKey };
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
  useEffect(() => {
    active.current = { key: scopeKey };
    setName("");
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
      !name.trim() ||
      saving ||
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
          createdBy: auth.currentUser?.uid || null,
        }));
      if (active.current !== requested) return;
      setCreatedOutlet(outlet);
      if (canManageApprovers)
        await setOutletApprovers(
          hotelUid,
          outlet.id,
          (users.data || []).filter((user) => selectedIds.includes(user.id)),
        );
      if (active.current === requested) navigate("/settings/outlets");
    } catch (failure) {
      if (active.current === requested)
        setError(failure.message || "Unable to save the outlet.");
    } finally {
      if (active.current === requested) setSaving(false);
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
            Create an operational purchasing outlet, then assign eligible order
            approvers.
          </p>
        </div>
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
                disabled={Boolean(createdOutlet) || saving || !canCreate}
                onChange={(event) => setName(event.target.value)}
                placeholder="Outlet name"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                required
              />
            </div>
            {canManageApprovers && (
              <>
                <OutletApproverPicker
                  users={users.data || []}
                  selectedIds={selectedIds}
                  onChange={setSelectedIds}
                  disabled={saving || users.loading || Boolean(users.error)}
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
                  saving ||
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
