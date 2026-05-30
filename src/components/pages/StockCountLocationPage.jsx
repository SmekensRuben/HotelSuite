import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import {
  getStockCountById,
  updateStockCountLocationCounts,
} from "../../services/firebaseStockCounts";
import { matchesSearchTokensAcross } from "../../utils/search";

function buildItemKey(item) {
  return `${String(item?.supplierProductId || "").trim()}::${String(item?.outletId || "").trim()}`;
}

function formatCurrency(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "EUR",
  }).format(Number(value || 0));
}

export default function StockCountLocationPage() {
  const { stockCountId, locationId } = useParams();
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [stockCount, setStockCount] = useState(null);
  const [stockCountLocation, setStockCountLocation] = useState(null);
  const [template, setTemplate] = useState(null);
  const [quantitiesByKey, setQuantitiesByKey] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

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
    const loadLocation = async () => {
      if (!hotelUid || !stockCountId || !locationId) return;
      setLoading(true);
      setError("");

      const nextStockCount = await getStockCountById(hotelUid, stockCountId);
      const nextLocation = (nextStockCount?.locations || []).find(
        (location) => location.locationId === locationId
      );

      const nextTemplate = nextLocation?.stockTemplate?.id ? nextLocation.stockTemplate : null;

      const nextQuantities = {};
      (nextLocation?.countedItems || []).forEach((item) => {
        nextQuantities[buildItemKey(item)] = String(item.quantity ?? "");
      });

      setStockCount(nextStockCount);
      setStockCountLocation(nextLocation || null);
      setTemplate(nextTemplate);
      setQuantitiesByKey(nextQuantities);
      setLoading(false);
    };

    loadLocation();
  }, [hotelUid, stockCountId, locationId]);

  const rows = useMemo(
    () =>
      (template?.items || []).map((item) => {
        const key = buildItemKey(item);
        const pricePerPurchaseUnit = Number(item.pricePerPurchaseUnit || 0);
        const quantityValue = quantitiesByKey[key] ?? "";
        const numericQuantity = quantityValue === "" ? 0 : Number(quantityValue);
        const totalValue = Number.isFinite(numericQuantity) ? numericQuantity * pricePerPurchaseUnit : 0;
        const content = item.content || `${item.baseUnitsPerPurchaseUnit || "-"} ${item.baseUnit || "-"} / ${item.purchaseUnit || "-"}`;

        return {
          id: key,
          ...item,
          key,
          supplierProductName: item.supplierProductName || item.name || "-",
          supplierName: item.supplierName || "-",
          content,
          outletName: item.outletName || item.outletId || "-",
          pricePerPurchaseUnit,
          pricePerPurchaseUnitLabel: formatCurrency(pricePerPurchaseUnit),
          quantity: quantityValue,
          totalValue,
          totalValueLabel: formatCurrency(totalValue),
        };
      }),
    [quantitiesByKey, template]
  );

  const filteredRows = useMemo(
    () =>
      rows.filter((row) =>
        matchesSearchTokensAcross(
          [
            row.supplierProductName,
            row.supplierName,
            row.content,
            row.outletName,
            row.supplierProductId,
          ],
          searchQuery
        )
      ),
    [rows, searchQuery]
  );

  const countedCount = rows.filter((row) => row.quantity !== "").length;
  const countedValue = rows.reduce((sum, row) => (row.quantity === "" ? sum : sum + row.totalValue), 0);

  const handleQuantityChange = (key) => (event) => {
    setQuantitiesByKey((prev) => ({ ...prev, [key]: event.target.value }));
  };

  const handleSave = async () => {
    if (!hotelUid || !stockCountId || !locationId) return;
    setSaving(true);
    setError("");

    try {
      const countedItems = rows
        .filter((row) => row.quantity !== "")
        .map((row) => ({
          supplierProductId: row.supplierProductId,
          outletId: row.outletId,
          quantity: Number(row.quantity || 0),
          pricePerPurchaseUnit: row.pricePerPurchaseUnit,
          totalValue: row.totalValue,
          countedAt: new Date(),
          countedBy: auth.currentUser?.uid || "unknown",
        }));

      await updateStockCountLocationCounts(
        hotelUid,
        stockCountId,
        locationId,
        countedItems,
        auth.currentUser?.uid || "unknown"
      );
      navigate(`/catalog/stock-counts/${stockCountId}`);
    } catch (saveError) {
      setError(saveError?.message || "Unable to save stock count location.");
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
            <p className="text-sm text-gray-500 uppercase tracking-wide">Stock Count</p>
            <h1 className="text-3xl font-semibold">Stock Count Location</h1>
            <p className="text-gray-600 mt-1">
              {stockCountLocation?.locationName || "Count supplier products for this location."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/catalog/stock-counts/${stockCountId}`)}
            className="inline-flex items-center justify-center rounded border border-gray-300 p-2 text-gray-700 hover:bg-gray-100"
            title="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <p className="text-gray-600">Loading stock count location...</p>
        ) : !stockCount || !stockCountLocation ? (
          <Card>
            <p className="text-gray-600">Stock count location not found.</p>
          </Card>
        ) : !template ? (
          <Card>
            <p className="text-gray-600">Stock count template not found.</p>
          </Card>
        ) : (
          <>
            <Card className="grid gap-4 md:grid-cols-3">
              <div>
                <p className="text-sm text-gray-500">Stock Count</p>
                <p className="font-semibold">{stockCount.name}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Template</p>
                <p className="font-semibold">{template.name}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Progress</p>
                <p className="font-semibold">{countedCount} / {rows.length} · {formatCurrency(countedValue)}</p>
              </div>
            </Card>

            <Card className="space-y-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <label htmlFor="stock-count-product-search" className="block text-sm font-medium text-gray-700 mb-1">
                    Search supplier product
                  </label>
                  <input
                    id="stock-count-product-search"
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search by supplier product, supplier, outlet or ID"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm sm:w-96"
                  />
                </div>
                <p className="text-sm text-gray-500">
                  Showing {filteredRows.length} of {rows.length} supplier products
                </p>
              </div>

              <DataListTable
                columns={[
                  { key: "supplierProductName", label: "Supplier Product" },
                  { key: "supplierName", label: "Supplier" },
                  { key: "content", label: "Content" },
                  { key: "outletName", label: "Outlet" },
                  { key: "pricePerPurchaseUnitLabel", label: "Price" },
                  {
                    key: "quantity",
                    label: "Count",
                    sortable: false,
                    render: (row) => (
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={row.quantity}
                        onClick={(event) => event.stopPropagation()}
                        onChange={handleQuantityChange(row.key)}
                        className="w-28 rounded border border-gray-300 px-2 py-1 text-sm"
                      />
                    ),
                  },
                  { key: "totalValueLabel", label: "Value", sortValue: (row) => row.totalValue },
                ]}
                rows={filteredRows}
                emptyMessage={searchQuery ? "No supplier products match your search." : "No stock template items yet."}
              />

              {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => navigate(`/catalog/stock-counts/${stockCountId}`)}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-2 rounded-lg bg-[#b41f1f] text-white text-sm font-semibold hover:bg-[#961919] disabled:opacity-60"
                >
                  {saving ? "Saving..." : "Save Counts"}
                </button>
              </div>
            </Card>
          </>
        )}
      </PageContainer>
    </div>
  );
}
