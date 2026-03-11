import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getOutlets } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";

export default function OutletSettingsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const canCreateOutlets = usePermission("settings", "create");
  const [outlets, setOutlets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");

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
    const loadOutlets = async () => {
      if (!hotelUid) return;
      setLoading(true);
      const result = await getOutlets(hotelUid);
      setOutlets(result);
      setLoading(false);
    };

    loadOutlets();
  }, [hotelUid]);

  const filteredOutlets = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return outlets.filter((outlet) => {
      const name = String(outlet.name || "").toLowerCase();
      return !term || name.includes(term);
    });
  }, [outlets, searchTerm]);

  const columns = [{ key: "name", label: "Name" }];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
            <h1 className="text-3xl font-semibold">Outlet Settings</h1>
            <p className="text-gray-600 mt-1">Manage outlets for this hotel.</p>
          </div>
          <button
            onClick={() => navigate("/settings/outlets/new")}
            disabled={!canCreateOutlets}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow ${
              canCreateOutlets
                ? "bg-[#b41f1f] text-white hover:bg-[#961919]"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
          >
            <Plus className="h-4 w-4" /> Add Outlet
          </button>
        </div>

        <div>
          <label className="sr-only" htmlFor="outlets-search">
            Search outlets
          </label>
          <input
            id="outlets-search"
            type="text"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search by outlet name"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
          />
        </div>

        {loading ? (
          <p className="text-gray-600">Loading outlets...</p>
        ) : (
          <DataListTable columns={columns} rows={filteredOutlets} emptyMessage="No outlets found." />
        )}
      </PageContainer>
    </div>
  );
}
