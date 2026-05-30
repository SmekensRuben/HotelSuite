import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import {
  finishStockCountLocation,
  getStockCountById,
  updateStockCountLocationCounts,
} from "../../services/firebaseStockCounts";
import { getSupplierProducts } from "../../services/firebaseProducts";
import { getOutlets } from "../../services/firebaseSettings";
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

function buildContent(item) {
  return item.content || `${item.baseUnitsPerPurchaseUnit || "-"} ${item.baseUnit || "-"} / ${item.purchaseUnit || "-"}`;
}

function buildSupplierProductSnapshot(product = {}, outlet = {}) {
  const baseUnitsPerPurchaseUnit = product.baseUnitsPerPurchaseUnit ?? "";
  const baseUnit = product.baseUnit || "";
  const purchaseUnit = product.purchaseUnit || "";

  return {
    supplierProductId: String(product.id || product.supplierProductId || "").trim(),
    outletId: String(outlet.id || "").trim(),
    supplierProductName: product.supplierProductName || product.name || "",
    supplierName: product.supplierName || "",
    baseUnitsPerPurchaseUnit,
    baseUnit,
    purchaseUnit,
    content: `${baseUnitsPerPurchaseUnit || "-"} ${baseUnit || "-"} / ${purchaseUnit || "-"}`,
    pricePerPurchaseUnit: Number(product.pricePerPurchaseUnit || 0),
    outletName: outlet.name || outlet.id || "",
  };
}

export default function StockCountLocationPage() {
  const { stockCountId, locationId } = useParams();
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [stockCount, setStockCount] = useState(null);
  const [stockCountLocation, setStockCountLocation] = useState(null);
  const [template, setTemplate] = useState(null);
  const [supplierProducts, setSupplierProducts] = useState([]);
  const [outlets, setOutlets] = useState([]);
  const [additionalItems, setAdditionalItems] = useState([]);
  const [quantitiesByKey, setQuantitiesByKey] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedOutletId, setSelectedOutletId] = useState("");
  const [showFinishModal, setShowFinishModal] = useState(false);
  const [selectedTemplateAdditions, setSelectedTemplateAdditions] = useState({});

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

  const loadLocation = async () => {
    if (!hotelUid || !stockCountId || !locationId) return;
    setLoading(true);
    setError("");

    try {
      const [nextStockCount, productResult, nextOutlets] = await Promise.all([
        getStockCountById(hotelUid, stockCountId),
        getSupplierProducts(hotelUid),
        getOutlets(hotelUid),
      ]);
      const nextLocation = (nextStockCount?.locations || []).find(
        (location) => location.locationId === locationId
      );

      const nextTemplate = nextLocation?.stockTemplate?.id ? nextLocation.stockTemplate : null;
      const templateKeys = new Set((nextTemplate?.items || []).map(buildItemKey));

      const nextQuantities = {};
      const nextAdditionalItems = [];
      (nextLocation?.countedItems || []).forEach((item) => {
        const key = buildItemKey(item);
        nextQuantities[key] = String(item.quantity ?? "");
        if (!templateKeys.has(key)) {
          nextAdditionalItems.push({ ...item, key, isTemplateItem: false });
        }
      });

      setStockCount(nextStockCount);
      setStockCountLocation(nextLocation || null);
      setTemplate(nextTemplate);
      setSupplierProducts(Array.isArray(productResult) ? productResult : productResult?.products || []);
      setOutlets(nextOutlets);
      setAdditionalItems(nextAdditionalItems);
      setQuantitiesByKey(nextQuantities);
    } catch (loadError) {
      setError(loadError?.message || "Unable to load stock count location.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLocation();
  }, [hotelUid, stockCountId, locationId]);

  const outletsById = useMemo(
    () => Object.fromEntries(outlets.map((outlet) => [String(outlet.id || "").trim(), outlet])),
    [outlets]
  );

  const templateKeys = useMemo(
    () => new Set((template?.items || []).map(buildItemKey)),
    [template]
  );

  const rows = useMemo(() => {
    const templateRows = (template?.items || []).map((item) => ({ ...item, isTemplateItem: true }));
    return [...templateRows, ...additionalItems].map((item) => {
      const key = buildItemKey(item);
      const pricePerPurchaseUnit = Number(item.pricePerPurchaseUnit || 0);
      const quantityValue = quantitiesByKey[key] ?? "";
      const numericQuantity = quantityValue === "" ? 0 : Number(quantityValue);
      const totalValue = Number.isFinite(numericQuantity) ? numericQuantity * pricePerPurchaseUnit : 0;
      const content = buildContent(item);

      return {
        id: key,
        ...item,
        key,
        isTemplateItem: item.isTemplateItem !== false,
        supplierProductName: item.supplierProductName || item.name || "-",
        supplierName: item.supplierName || "-",
        content,
        outletName: item.outletName || outletsById[item.outletId]?.name || item.outletId || "-",
        pricePerPurchaseUnit,
        pricePerPurchaseUnitLabel: formatCurrency(pricePerPurchaseUnit),
        quantity: quantityValue,
        totalValue,
        totalValueLabel: formatCurrency(totalValue),
        sourceLabel: item.isTemplateItem === false ? "Added" : "Template",
      };
    });
  }, [additionalItems, outletsById, quantitiesByKey, template]);

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
            row.sourceLabel,
          ],
          searchQuery
        )
      ),
    [rows, searchQuery]
  );

  const addedRows = useMemo(
    () => rows.filter((row) => !templateKeys.has(buildItemKey(row))),
    [rows, templateKeys]
  );

  const countedCount = rows.filter((row) => row.quantity !== "").length;
  const countedValue = rows.reduce((sum, row) => (row.quantity === "" ? sum : sum + row.totalValue), 0);
  const filteredProducts = supplierProducts.filter((product) =>
    matchesSearchTokensAcross(
      [product.supplierProductName, product.name, product.supplierName, product.supplierSku, product.id],
      addSearch
    )
  );

  const buildCountedItems = () =>
    rows
      .filter((row) => row.quantity !== "" || !templateKeys.has(buildItemKey(row)))
      .map((row) => ({
        supplierProductId: row.supplierProductId,
        outletId: row.outletId,
        quantity: Number(row.quantity || 0),
        pricePerPurchaseUnit: row.pricePerPurchaseUnit,
        totalValue: row.totalValue,
        countedAt: new Date(),
        countedBy: auth.currentUser?.uid || "unknown",
        isTemplateItem: templateKeys.has(buildItemKey(row)),
        supplierProductName: row.supplierProductName,
        supplierName: row.supplierName,
        baseUnitsPerPurchaseUnit: row.baseUnitsPerPurchaseUnit ?? "",
        baseUnit: row.baseUnit || "",
        purchaseUnit: row.purchaseUnit || "",
        content: row.content,
        outletName: row.outletName,
      }));

  const handleQuantityChange = (key) => (event) => {
    setQuantitiesByKey((prev) => ({ ...prev, [key]: event.target.value }));
  };

  const handleAddSupplierProduct = () => {
    if (!selectedProduct || !selectedOutletId) return;
    const outlet = outletsById[selectedOutletId] || { id: selectedOutletId };
    const nextItem = { ...buildSupplierProductSnapshot(selectedProduct, outlet), isTemplateItem: false };
    const key = buildItemKey(nextItem);

    if (rows.some((row) => row.key === key)) {
      setError("This supplier product and outlet is already on this stock count location.");
      return;
    }

    setAdditionalItems((prev) => [...prev, { ...nextItem, key }]);
    setQuantitiesByKey((prev) => ({ ...prev, [key]: prev[key] ?? "" }));
    setSelectedProduct(null);
    setSelectedOutletId("");
    setAddSearch("");
    setShowAddModal(false);
    setError("");
  };

  const handleSave = async () => {
    if (!hotelUid || !stockCountId || !locationId) return;
    setSaving(true);
    setError("");

    try {
      await updateStockCountLocationCounts(
        hotelUid,
        stockCountId,
        locationId,
        buildCountedItems(),
        auth.currentUser?.uid || "unknown"
      );
      navigate(`/catalog/stock-counts/${stockCountId}`);
    } catch (saveError) {
      setError(saveError?.message || "Unable to save stock count location.");
    } finally {
      setSaving(false);
    }
  };

  const handleFinishClick = () => {
    const defaultSelections = Object.fromEntries(addedRows.map((row) => [row.key, true]));
    setSelectedTemplateAdditions(defaultSelections);
    if (addedRows.length > 0) {
      setShowFinishModal(true);
      return;
    }
    handleFinish([]);
  };

  const handleFinish = async (templateRowsToAdd) => {
    if (!hotelUid || !stockCountId || !locationId) return;
    setSaving(true);
    setError("");

    try {
      await finishStockCountLocation(
        hotelUid,
        stockCountId,
        locationId,
        buildCountedItems(),
        templateRowsToAdd.map((row) => ({ supplierProductId: row.supplierProductId, outletId: row.outletId })),
        auth.currentUser?.uid || "unknown"
      );
      navigate(`/catalog/stock-counts/${stockCountId}`);
    } catch (finishError) {
      setError(finishError?.message || "Unable to finish stock count location.");
    } finally {
      setSaving(false);
      setShowFinishModal(false);
    }
  };

  const selectedRowsToAddToTemplate = addedRows.filter((row) => selectedTemplateAdditions[row.key]);

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
            <Card className="grid gap-4 md:grid-cols-4">
              <div>
                <p className="text-sm text-gray-500">Stock Count</p>
                <p className="font-semibold">{stockCount.name}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Template</p>
                <p className="font-semibold">{template.name}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Status</p>
                <p className="font-semibold">{stockCountLocation.status || "Not Started"}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Progress</p>
                <p className="font-semibold">{countedCount} / {rows.length} · {formatCurrency(countedValue)}</p>
              </div>
            </Card>

            <Card className="space-y-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
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
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <p className="text-sm text-gray-500">
                    Showing {filteredRows.length} of {rows.length} supplier products
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowAddModal(true)}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
                  >
                    <Plus className="h-4 w-4" /> Add Supplier Product
                  </button>
                </div>
              </div>

              <DataListTable
                columns={[
                  { key: "supplierProductName", label: "Supplier Product" },
                  { key: "supplierName", label: "Supplier" },
                  { key: "content", label: "Content" },
                  { key: "outletName", label: "Outlet" },
                  { key: "sourceLabel", label: "Source" },
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

              <div className="flex flex-wrap justify-end gap-2">
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
                  className="px-4 py-2 rounded-lg border border-[#b41f1f] text-[#b41f1f] text-sm font-semibold hover:bg-red-50 disabled:opacity-60"
                >
                  {saving ? "Saving..." : "Save Counts"}
                </button>
                <button
                  type="button"
                  onClick={handleFinishClick}
                  disabled={saving || stockCountLocation.status === "Finished"}
                  className="px-4 py-2 rounded-lg bg-[#b41f1f] text-white text-sm font-semibold hover:bg-[#961919] disabled:opacity-60"
                >
                  {saving ? "Finishing..." : "Set Finished"}
                </button>
              </div>
            </Card>
          </>
        )}
      </PageContainer>

      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="Add Supplier Product">
        <div className="space-y-3">
          <input
            type="search"
            value={addSearch}
            onChange={(event) => setAddSearch(event.target.value)}
            placeholder="Search supplier product"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <div className="max-h-56 overflow-y-auto rounded border border-gray-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left">
                  <th className="px-2 py-2">Supplier Product</th>
                  <th className="px-2 py-2">Supplier</th>
                  <th className="px-2 py-2">Content</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.slice(0, 25).map((product) => {
                  const content = buildContent(product);
                  const isSelected = selectedProduct?.id === product.id;
                  return (
                    <tr
                      key={product.id}
                      className={`cursor-pointer ${isSelected ? "bg-blue-50" : "hover:bg-gray-50"}`}
                      onClick={() => setSelectedProduct(product)}
                    >
                      <td className="px-2 py-2">{product.supplierProductName || product.name || "-"}</td>
                      <td className="px-2 py-2">{product.supplierName || "-"}</td>
                      <td className="px-2 py-2">{content}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <select
            value={selectedOutletId}
            onChange={(event) => setSelectedOutletId(event.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">Select outlet</option>
            {outlets.map((outlet) => (
              <option key={outlet.id} value={outlet.id}>{outlet.name}</option>
            ))}
          </select>
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded border border-gray-300 px-3 py-2 text-sm" onClick={() => setShowAddModal(false)}>Cancel</button>
            <button
              type="button"
              className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-60"
              disabled={!selectedProduct || !selectedOutletId}
              onClick={handleAddSupplierProduct}
            >
              Add
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={showFinishModal} onClose={() => setShowFinishModal(false)} title="Add products to template?">
        <div className="space-y-4">
          <p className="text-sm text-gray-700">
            {addedRows.length} supplier product{addedRows.length === 1 ? " was" : "s were"} added to this Stock Count Location that {addedRows.length === 1 ? "is" : "are"} not in the template.
            Should these supplier products also be added to the template now?
          </p>
          <div className="max-h-64 space-y-2 overflow-y-auto rounded border border-gray-200 p-2">
            {addedRows.map((row) => (
              <label key={row.key} className="flex items-start gap-2 rounded px-2 py-1 text-sm hover:bg-gray-50">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selectedTemplateAdditions[row.key] !== false}
                  onChange={(event) =>
                    setSelectedTemplateAdditions((prev) => ({ ...prev, [row.key]: event.target.checked }))
                  }
                />
                <span>
                  <span className="font-medium">{row.supplierProductName}</span>
                  <span className="text-gray-500"> · {row.supplierName} · {row.outletName}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="rounded border border-gray-300 px-3 py-2 text-sm" onClick={() => setShowFinishModal(false)}>Cancel</button>
            <button type="button" className="rounded border border-gray-300 px-3 py-2 text-sm" onClick={() => handleFinish([])} disabled={saving}>Finish without adding</button>
            <button type="button" className="rounded bg-[#b41f1f] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60" onClick={() => handleFinish(selectedRowsToAddToTemplate)} disabled={saving}>
              Finish and add selected
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
