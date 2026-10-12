import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
  getOutletApprovers,
  getOutletById,
  setOutletApprovers,
  updateOutlet,
} from "../../services/firebaseSettings";

export default function OutletEditPage() {
  const navigate = useNavigate(),
    { outletId } = useParams(),
    { hotelUid } = useHotelContext();
  const canUpdate = usePermission("outlets", "update"),
    canManageApprovers = usePermission("outlets", "approvers");
  const [name, setName] = useState(""),
    [selectedIds, setSelectedIds] = useState([]),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const scopeKey = `${hotelUid}:${outletId}:${canManageApprovers}`;
  const active = useRef({ key: scopeKey });
  if (active.current.key !== scopeKey) active.current = { key: scopeKey };
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
    active.current = { key: scopeKey };
    setName("");
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
      setSelectedIds(query.data.approvers.map((user) => user.id));
    }
  }, [query.data]);
  const outlet = query.data?.outlet;
  const submit = async (event) => {
    event.preventDefault();
    if (
      !canUpdate ||
      !hotelUid ||
      !outletId ||
      !name.trim() ||
      saving ||
      !outlet ||
      outlet.archived === true
    )
      return;
    const requested = active.current;
    setSaving(true);
    setError("");
    try {
      await updateOutlet(hotelUid, outletId, {
        name: name.trim(),
        updatedBy: auth.currentUser?.uid || null,
      });
      if (active.current !== requested) return;
      if (canManageApprovers)
        await setOutletApprovers(
          hotelUid,
          outletId,
          query.data.users.filter((user) => selectedIds.includes(user.id)),
        );
      if (active.current === requested)
        navigate(`/settings/outlets/${outletId}`);
    } catch (failure) {
      if (active.current === requested)
        setError(failure.message || "Unable to save the outlet.");
    } finally {
      if (active.current === requested) setSaving(false);
    }
  };
  const disabled =
    !canUpdate ||
    saving ||
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
                  disabled={disabled}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Outlet name"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  required
                />
              </div>
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
