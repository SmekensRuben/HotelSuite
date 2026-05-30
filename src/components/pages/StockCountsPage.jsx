import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { getStockCounts } from "../../services/firebaseStockCounts";

export default function StockCountsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const canCreateStockCounts = usePermission("stockcounts", "create");
  const [stockCounts, setStockCounts] = useState([]);
  const [loading, setLoading] = useState(true);

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
    const loadStockCounts = async () => {
      if (!hotelUid) return;
      setLoading(true);
      const result = await getStockCounts(hotelUid);
      setStockCounts(result);
      setLoading(false);
    };

    loadStockCounts();
  }, [hotelUid]);

  const columns = [
    { key: "name", label: "Name" },
    { key: "type", label: "Type" },
    { key: "locationSummary", label: "Locations", sortValue: (row) => row.locationCount },
    { key: "createdAtLabel", label: "Created", sortValue: (row) => row.createdAt?.getTime?.() || 0 },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
            <h1 className="text-3xl font-semibold">Stock Counts</h1>
            <p className="text-gray-600 mt-1">Manage stock count runs for selected locations.</p>
          </div>
          <button
            onClick={() => navigate("/catalog/stock-counts/new")}
            disabled={!canCreateStockCounts}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow ${
              canCreateStockCounts
                ? "bg-[#b41f1f] text-white hover:bg-[#961919]"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
            title="Add stock count"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading stock counts...</p>
        ) : (
          <DataListTable
            columns={columns}
            rows={stockCounts}
            emptyMessage="No stock counts found."
            onRowClick={(row) => navigate(`/catalog/stock-counts/${row.id}`)}
          />
        )}
      </PageContainer>
    </div>
  );
}
