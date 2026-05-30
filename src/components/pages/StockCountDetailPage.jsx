import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getStockCountById } from "../../services/firebaseStockCounts";

function formatCurrency(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "EUR",
  }).format(Number(value || 0));
}

function getLocationStatus(location, countedCount) {
  if (location?.status === "Finished") return "Finished";
  if (countedCount === 0) return "Not Started";
  return location?.status && location.status !== "Not Started" ? location.status : "In Progress";
}

export default function StockCountDetailPage() {
  const { stockCountId } = useParams();
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [stockCount, setStockCount] = useState(null);
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
    const loadStockCount = async () => {
      if (!hotelUid || !stockCountId) return;
      setLoading(true);
      const nextStockCount = await getStockCountById(hotelUid, stockCountId);
      setStockCount(nextStockCount);
      setLoading(false);
    };

    loadStockCount();
  }, [hotelUid, stockCountId]);

  const rows = useMemo(
    () =>
      (stockCount?.locations || []).map((location) => {
        const countedItems = Array.isArray(location.countedItems) ? location.countedItems : [];
        const countedCount = countedItems.length;
        const countedValue = countedItems.reduce(
          (sum, item) => sum + Number(item?.totalValue || 0),
          0
        );
        const templateCount = Array.isArray(location.stockTemplate?.items) ? location.stockTemplate.items.length : 0;

        return {
          id: location.locationId,
          locationId: location.locationId,
          locationName: location.locationName || "-",
          countedCount,
          countedCountLabel: `${countedCount} / ${templateCount}`,
          countedValue,
          countedValueLabel: formatCurrency(countedValue),
          status: getLocationStatus(location, countedCount),
        };
      }),
    [stockCount]
  );

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
            <h1 className="text-3xl font-semibold">Stock Count Detail</h1>
            <p className="text-gray-600 mt-1">
              {stockCount?.name || "Review the selected stock count locations."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/catalog/stock-counts")}
            className="inline-flex items-center justify-center rounded border border-gray-300 p-2 text-gray-700 hover:bg-gray-100"
            title="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading stock count...</p>
        ) : !stockCount ? (
          <Card>
            <p className="text-gray-600">Stock count not found.</p>
          </Card>
        ) : (
          <Card>
            <DataListTable
              columns={[
                { key: "locationName", label: "Location" },
                { key: "countedCountLabel", label: "Counted Supplier Products", sortValue: (row) => row.countedCount },
                { key: "countedValueLabel", label: "Counted Value", sortValue: (row) => row.countedValue },
                { key: "status", label: "Status" },
              ]}
              rows={rows}
              emptyMessage="No stock count locations found."
              onRowClick={(row) => navigate(`/catalog/stock-counts/${stockCountId}/locations/${row.locationId}`)}
            />
          </Card>
        )}
      </PageContainer>
    </div>
  );
}
