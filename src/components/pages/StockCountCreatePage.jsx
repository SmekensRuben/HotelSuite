import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createStockCount, STOCK_COUNT_TYPES } from "../../services/firebaseStockCounts";
import { getLocationStockTemplates, getLocations, getOutlets } from "../../services/firebaseSettings";
import { getSupplierProducts } from "../../services/firebaseProducts";

const initialValues = {
  name: "",
  type: "Ad Hoc",
};

export default function StockCountCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [formValues, setFormValues] = useState(initialValues);
  const [locationRows, setLocationRows] = useState([]);
  const [supplierProducts, setSupplierProducts] = useState([]);
  const [outlets, setOutlets] = useState([]);
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

  const selectedRows = useMemo(
    () => locationRows.filter((row) => row.selected),
    [locationRows]
  );

  const hasSelectedLocationWithoutTemplate = selectedRows.some(
    (row) => row.templates.length === 0 || !row.stockTemplateId
  );

  const supplierProductsById = useMemo(
    () => Object.fromEntries(supplierProducts.map((product) => [String(product.id || "").trim(), product])),
    [supplierProducts]
  );

  const outletsById = useMemo(
    () => Object.fromEntries(outlets.map((outlet) => [String(outlet.id || "").trim(), outlet])),
    [outlets]
  );

  const buildTemplateSnapshot = (template) => ({
    ...(template || {}),
    items: Array.isArray(template?.items)
      ? template.items.map((item) => {
          const supplierProductId = String(item?.supplierProductId || "").trim();
          const outletId = String(item?.outletId || "").trim();
          const supplierProduct = supplierProductsById[supplierProductId] || {};
          const outlet = outletsById[outletId] || {};
          const baseUnitsPerPurchaseUnit = supplierProduct.baseUnitsPerPurchaseUnit ?? item.baseUnitsPerPurchaseUnit ?? "";
          const baseUnit = supplierProduct.baseUnit || item.baseUnit || "";
          const purchaseUnit = supplierProduct.purchaseUnit || item.purchaseUnit || "";

          return {
            ...item,
            supplierProductId,
            outletId,
            supplierProductName: supplierProduct.supplierProductName || supplierProduct.name || item.supplierProductName || "",
            supplierName: supplierProduct.supplierName || item.supplierName || "",
            baseUnitsPerPurchaseUnit,
            baseUnit,
            purchaseUnit,
            content: item.content || `${baseUnitsPerPurchaseUnit || "-"} ${baseUnit || "-"} / ${purchaseUnit || "-"}`,
            pricePerPurchaseUnit: Number(supplierProduct.pricePerPurchaseUnit ?? item.pricePerPurchaseUnit ?? 0),
            outletName: outlet.name || item.outletName || outletId,
          };
        })
      : [],
  });

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  useEffect(() => {
    const loadLocationsAndTemplates = async () => {
      if (!hotelUid) return;
      setLoading(true);
      const [locations, productResult, nextOutlets] = await Promise.all([
        getLocations(hotelUid),
        getSupplierProducts(hotelUid),
        getOutlets(hotelUid),
      ]);
      const rows = await Promise.all(
        locations.map(async (location) => {
          const templates = await getLocationStockTemplates(hotelUid, location.id);
          const firstTemplate = templates[0] || null;
          return {
            locationId: location.id,
            locationName: location.name,
            selected: true,
            templates,
            stockTemplateId: firstTemplate?.id || "",
          };
        })
      );
      setSupplierProducts(Array.isArray(productResult) ? productResult : productResult?.products || []);
      setOutlets(nextOutlets);
      setLocationRows(rows);
      setLoading(false);
    };

    loadLocationsAndTemplates();
  }, [hotelUid]);

  const handleFieldChange = (field) => (event) => {
    setFormValues((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const toggleLocation = (locationId) => {
    setLocationRows((prev) =>
      prev.map((row) =>
        row.locationId === locationId ? { ...row, selected: !row.selected } : row
      )
    );
  };

  const handleTemplateChange = (locationId, stockTemplateId) => {
    setLocationRows((prev) =>
      prev.map((row) =>
        row.locationId === locationId ? { ...row, stockTemplateId } : row
      )
    );
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");

    if (!hotelUid || !formValues.name.trim()) return;
    if (!selectedRows.length) {
      setError("Select at least one location.");
      return;
    }
    if (hasSelectedLocationWithoutTemplate) {
      setError("Every selected location needs a stock count template.");
      return;
    }

    setSaving(true);
    try {
      const locations = selectedRows.map((row) => {
        const template = row.templates.find((item) => item.id === row.stockTemplateId);
        const stockTemplate = buildTemplateSnapshot(template);
        return {
          locationId: row.locationId,
          locationName: row.locationName,
          stockTemplateId: row.stockTemplateId,
          stockTemplateName: stockTemplate.name || "",
          stockTemplate,
        };
      });

      await createStockCount(hotelUid, {
        ...formValues,
        locations,
        createdBy: auth.currentUser?.uid || "unknown",
      });
      navigate("/catalog/stock-counts");
    } catch (submitError) {
      setError(submitError?.message || "Unable to create stock count.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
          <h1 className="text-3xl font-semibold">Create Stock Count</h1>
          <p className="text-gray-600 mt-1">
            Select the locations that need to be counted and choose a stock count template per location.
          </p>
        </div>

        <Card>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="stock-count-name" className="block text-sm font-medium text-gray-700 mb-1">
                  Name
                </label>
                <input
                  id="stock-count-name"
                  type="text"
                  value={formValues.name}
                  onChange={handleFieldChange("name")}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  required
                />
              </div>

              <div>
                <label htmlFor="stock-count-type" className="block text-sm font-medium text-gray-700 mb-1">
                  Type
                </label>
                <select
                  id="stock-count-type"
                  value={formValues.type}
                  onChange={handleFieldChange("type")}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                >
                  {STOCK_COUNT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Locations</h2>
                <p className="text-sm text-gray-600">
                  All locations are selected by default. Change the template where needed.
                </p>
              </div>

              {loading ? (
                <p className="text-gray-600">Loading locations...</p>
              ) : locationRows.length === 0 ? (
                <p className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-sm text-gray-500">
                  No locations found.
                </p>
              ) : (
                <div className="overflow-hidden rounded-xl border border-gray-200">
                  <div className="divide-y divide-gray-100 bg-white">
                    {locationRows.map((row) => (
                      <div key={row.locationId} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(220px,320px)] md:items-center">
                        <label className="inline-flex items-center gap-3 text-sm font-medium text-gray-800">
                          <input
                            type="checkbox"
                            checked={row.selected}
                            onChange={() => toggleLocation(row.locationId)}
                            className="h-4 w-4 rounded border-gray-300 text-[#b41f1f] focus:ring-[#b41f1f]"
                          />
                          <span>{row.locationName}</span>
                        </label>

                        <select
                          value={row.stockTemplateId}
                          onChange={(event) => handleTemplateChange(row.locationId, event.target.value)}
                          disabled={!row.selected || row.templates.length === 0}
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:bg-gray-100 disabled:text-gray-500"
                        >
                          {row.templates.length === 0 ? (
                            <option value="">No templates available</option>
                          ) : (
                            row.templates.map((template) => (
                              <option key={template.id} value={template.id}>
                                {template.name}
                              </option>
                            ))
                          )}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => navigate("/catalog/stock-counts")}
                className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || loading || selectedRows.length === 0 || hasSelectedLocationWithoutTemplate}
                className="px-4 py-2 rounded-lg bg-[#b41f1f] text-white text-sm font-semibold hover:bg-[#961919] disabled:opacity-60"
              >
                {saving ? "Saving..." : "Save Stock Count"}
              </button>
            </div>
          </form>
        </Card>
      </PageContainer>
    </div>
  );
}
