import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { finishStockCount, getStockCountById } from "../../services/firebaseStockCounts";

function formatCurrency(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "EUR",
  }).format(Number(value || 0));
}

function buildItemKey(item) {
  return `${String(item?.supplierProductId || "").trim()}::${String(item?.outletId || "").trim()}`;
}

function getUniqueItemCount(templateItems = [], countedItems = []) {
  return new Set(
    [...templateItems, ...countedItems]
      .map(buildItemKey)
      .filter((key) => key !== "::")
  ).size;
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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
      setError("");
      try {
        const nextStockCount = await getStockCountById(hotelUid, stockCountId);
        setStockCount(nextStockCount);
      } catch (loadError) {
        setError(loadError?.message || "Unable to load stock count.");
      } finally {
        setLoading(false);
      }
    };

    loadStockCount();
  }, [hotelUid, stockCountId]);

  const rows = useMemo(
    () =>
      (stockCount?.locations || []).map((location) => {
        const countedItems = Array.isArray(location.countedItems) ? location.countedItems : [];
        const countedCount = new Set(
          countedItems
            .filter((item) => item?.isCounted !== false)
            .map(buildItemKey)
            .filter((key) => key !== "::")
        ).size;
        const countedValue = countedItems.reduce(
          (sum, item) => sum + Number(item?.totalValue || 0),
          0
        );
        const templateItems = Array.isArray(location.stockTemplate?.items) ? location.stockTemplate.items : [];
        const totalCountableItems = getUniqueItemCount(templateItems, countedItems);

        return {
          id: location.locationId,
          locationId: location.locationId,
          locationName: location.locationName || "-",
          countedCount,
          countedCountLabel: `${countedCount} / ${totalCountableItems}`,
          countedValue,
          countedValueLabel: formatCurrency(countedValue),
          status: getLocationStatus(location, countedCount),
        };
      }),
    [stockCount]
  );

  const totalCountedValue = rows.reduce((sum, row) => sum + Number(row.countedValue || 0), 0);
  const allLocationsFinished = rows.length > 0 && rows.every((row) => row.status === "Finished");
  const isStockCountFinished = stockCount?.status === "Finished";
  const canFinishStockCount = Boolean(stockCount) && allLocationsFinished && !isStockCountFinished;

  const handleFinishStockCount = async () => {
    if (!hotelUid || !stockCountId || !canFinishStockCount) return;
    setSaving(true);
    setError("");

    try {
      await finishStockCount(hotelUid, stockCountId, auth.currentUser?.uid || "unknown");
      const nextStockCount = await getStockCountById(hotelUid, stockCountId);
      setStockCount(nextStockCount);
    } catch (finishError) {
      setError(finishError?.message || "Unable to finish stock count.");
    } finally {
      setSaving(false);
    }
  };

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
          <>
            <Card className="grid gap-4 md:grid-cols-4">
              <div>
                <p className="text-sm text-gray-500">Type</p>
                <p className="font-semibold">{stockCount.type}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Status</p>
                <p className="font-semibold">{stockCount.status}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Locations</p>
                <p className="font-semibold">{stockCount.locationSummary}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Counted Value</p>
                <p className="font-semibold">{formatCurrency(totalCountedValue)}</p>
              </div>
            </Card>

            <Card className="space-y-4">
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

              {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

              <div className="flex flex-col items-end gap-2">
                <button
                  type="button"
                  onClick={handleFinishStockCount}
                  disabled={saving || !canFinishStockCount}
                  className="rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#961919] disabled:cursor-not-allowed disabled:opacity-60"
                  title={
                    isStockCountFinished
                      ? "This Stock Count is already Finished"
                      : allLocationsFinished
                        ? "Finish Stock Count"
                        : "All Stock Count Locations must be Finished first"
                  }
                >
                  {saving ? "Finishing..." : "Finish Stock Count"}
                </button>
                {!allLocationsFinished && !isStockCountFinished && (
                  <p className="text-sm text-gray-500">All Stock Count Locations must be Finished before this button is clickable.</p>
                )}
              </div>
            </Card>
          </>
        )}
      </PageContainer>
    </div>
  );
}
