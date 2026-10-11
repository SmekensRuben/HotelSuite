import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { usePermission } from "../../hooks/usePermission";
import { useHotelContext } from "../../contexts/HotelContext";
import { listHotelUsers } from "../../services/firebaseOnboarding";
import {
  getOutletApprovers,
  getOutletById,
  setOutletApprovers,
  updateOutlet,
} from "../../services/firebaseSettings";

export default function OutletEditPage() {
  const navigate = useNavigate();
  const { outletId } = useParams();
  const { hotelUid } = useHotelContext();
  const canManageApprovers = usePermission("outlets", "approvers");
  const [saveError, setSaveError] = useState("");
  const [name, setName] = useState("");
  const [users, setUsers] = useState([]);
  const [selectedApproverIds, setSelectedApproverIds] = useState([]);
  const [saving, setSaving] = useState(false);

  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    []
  );

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  useEffect(() => {
    const init = async () => {
      if (!hotelUid || !outletId) return;
      const [allUsers, outlet, approvers] = await Promise.all([
        canManageApprovers ? listHotelUsers(hotelUid) : Promise.resolve([]),
        getOutletById(hotelUid, outletId),
        canManageApprovers ? getOutletApprovers(hotelUid, outletId) : Promise.resolve([]),
      ]);
      const filteredUsers = allUsers.filter((user) => user.canApprove);
      setUsers(filteredUsers);
      setName(String(outlet?.name || ""));
      setSelectedApproverIds(approvers.map((item) => item.id));
    };

    init().catch((error) => setSaveError(error.message || "Unable to load the outlet."));
  }, [hotelUid, outletId, canManageApprovers]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!hotelUid || !outletId || !name.trim()) return;

    setSaving(true);
    setSaveError("");
    try {
      const selectedUsers = users.filter((user) => selectedApproverIds.includes(user.id));
      await updateOutlet(hotelUid, outletId, {
        name: name.trim(),
        updatedBy: auth.currentUser?.uid || "unknown",
      });
      if (canManageApprovers) await setOutletApprovers(
        hotelUid,
        outletId,
        selectedUsers.map((user) => ({
          id: user.id,
          email: user.email || "",
          firstName: user.firstName || "",
          lastName: user.lastName || "",
          displayName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
        }))
      );
      navigate(`/settings/outlets/${outletId}`);
    } catch (error) { setSaveError(error.message || "Unable to save the outlet."); }
    finally { setSaving(false); }
  };

  const toggleApprover = (userId) => {
    setSelectedApproverIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
          <h1 className="text-3xl font-semibold">Edit Outlet</h1>
        </div>

        <Card>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="outlet-name" className="block text-sm font-medium text-gray-700 mb-1">
                Name
              </label>
              <input
                id="outlet-name"
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Outlet name"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                required
              />
            </div>

            {canManageApprovers && <div>
              <p className="block text-sm font-medium text-gray-700 mb-2">Approvers</p>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 p-3 space-y-2">
                {users.map((user) => {
                  const label = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || user.id;
                  return (
                    <label key={user.id} className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={selectedApproverIds.includes(user.id)}
                        onChange={() => toggleApprover(user.id)}
                      />
                      <span>{label} {user.email ? `(${user.email})` : ""}</span>
                    </label>
                  );
                })}
              </div>
            </div>}

            {saveError && <p role="alert" className="text-sm text-red-700">{saveError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => navigate(`/settings/outlets/${outletId}`)}
                className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-brand-800 text-white text-sm font-semibold hover:bg-brand-950 disabled:opacity-60"
              >
                {saving ? "Saving..." : "Save Outlet"}
              </button>
            </div>
          </form>
        </Card>
      </PageContainer>
    </div>
  );
}
