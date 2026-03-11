import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createOutlet } from "../../services/firebaseSettings";

export default function OutletCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [name, setName] = useState("");
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

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!hotelUid || !name.trim()) return;

    setSaving(true);
    await createOutlet(hotelUid, {
      name: name.trim(),
      createdBy: auth.currentUser?.uid || "unknown",
    });
    setSaving(false);
    navigate("/settings/outlets");
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
          <h1 className="text-3xl font-semibold">Add Outlet</h1>
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
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
                required
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => navigate("/settings/outlets")}
                className="px-4 py-2 rounded border border-gray-300 text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || !name.trim()}
                className={`px-4 py-2 rounded text-white ${
                  saving || !name.trim()
                    ? "bg-gray-400 cursor-not-allowed"
                    : "bg-[#b41f1f] hover:bg-[#961919]"
                }`}
              >
                {saving ? "Creating..." : "Create Outlet"}
              </button>
            </div>
          </form>
        </Card>
      </PageContainer>
    </div>
  );
}
