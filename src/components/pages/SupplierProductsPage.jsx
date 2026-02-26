import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierProducts } from "../../services/firebaseProducts";
import { usePermission } from "../../hooks/usePermission";

const PAGE_SIZE = 50;

export default function SupplierProductsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { hotelUid } = useHotelContext();
  const canCreateProducts = usePermission("supplierproducts", "create");
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMorePages, setHasMorePages] = useState(false);
  const [pageStartCursors, setPageStartCursors] = useState({ 0: null });

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

  const loadProductsPage = async (nextPageIndex, cursor) => {
    if (!hotelUid) return;
    setLoading(true);

    const normalizedStatus = selectedStatus.trim().toLowerCase();
    const activeFilter = normalizedStatus === "active" ? true : normalizedStatus === "inactive" ? false : null;
    const result = await getSupplierProducts(hotelUid, {
      pageSize: PAGE_SIZE,
      cursor,
      searchTerm: debouncedSearchTerm,
      supplierId: selectedSupplierId,
      active: activeFilter,
    });

    setProducts(result.products);
    setHasMorePages(result.hasMore);
    setPageIndex(nextPageIndex);

    if (result.hasMore && result.cursor) {
      setPageStartCursors((prev) => ({
        ...prev,
        [nextPageIndex + 1]: result.cursor,
      }));
    }

    setLoading(false);
  };

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebouncedSearchTerm(searchTerm), 300);
    return () => clearTimeout(timeoutId);
  }, [searchTerm]);

  useEffect(() => {
    if (!hotelUid) return;
    setPageStartCursors({ 0: null });
    loadProductsPage(0, null);
  }, [hotelUid, debouncedSearchTerm, selectedSupplierId, selectedStatus]);

  const supplierIds = useMemo(() => {
    const values = new Set(
      products
        .map((product) => String(product.supplierId || "").trim())
        .filter(Boolean)
    );
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [products]);

  const columns = [
    { key: "supplierId", label: "Supplier ID" },
    { key: "supplierSku", label: "Supplier SKU" },
    { key: "supplierProductName", label: "Supplier Product Name" },
    { key: "baseUnit", label: "Base Unit" },
    { key: "pricingModel", label: "Pricing Model" },
    {
      key: "active",
      label: t("products.columns.status"),
      sortValue: (product) => (product.active !== false ? 1 : 0),
      render: (product) => (
        <span
          className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
            product.active !== false
              ? "bg-green-100 text-green-700"
              : "bg-gray-200 text-gray-700"
          }`}
        >
          {product.active !== false ? t("products.status.active") : t("products.status.inactive")}
        </span>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">{t("products.catalog")}</p>
            <h1 className="text-3xl font-semibold">Supplier Products</h1>
            <p className="text-gray-600 mt-1">{t("products.subtitle")}</p>
          </div>
          <button
            onClick={() => navigate("/catalog/supplier-products/new")}
            disabled={!canCreateProducts}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow ${
              canCreateProducts
                ? "bg-[#b41f1f] text-white hover:bg-[#961919]"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
          >
            <Plus className="h-4 w-4" /> {t("products.actions.new")}
          </button>
        </div>

        <div>
          <label className="sr-only" htmlFor="products-search">
            {t("products.filter.label")}
          </label>
          <input
            id="products-search"
            type="text"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search by supplier id, supplier sku or name"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <select
            value={selectedSupplierId}
            onChange={(event) => setSelectedSupplierId(event.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
          >
            <option value="">All suppliers</option>
            {supplierIds.map((supplierId) => (
              <option key={supplierId} value={supplierId}>
                {supplierId}
              </option>
            ))}
          </select>

          <select
            value={selectedStatus}
            onChange={(event) => setSelectedStatus(event.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
          >
            <option value="">All statuses</option>
            <option value="active">{t("products.status.active")}</option>
            <option value="inactive">{t("products.status.inactive")}</option>
          </select>
        </div>

        {loading ? (
          <p className="text-gray-600">{t("products.loading")}</p>
        ) : (
            <DataListTable
              columns={columns}
              rows={products}
              onRowClick={(product) => navigate(`/catalog/supplier-products/${product.id}`)}
              emptyMessage={t("products.table.empty")}
            />
        )}

        <div className="flex items-center justify-between border-t border-gray-200 pt-4">
          <p className="text-sm text-gray-500">Page {pageIndex + 1}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const previousPage = Math.max(pageIndex - 1, 0);
                loadProductsPage(previousPage, pageStartCursors[previousPage] ?? null);
              }}
              disabled={loading || pageIndex === 0}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => {
                if (!hasMorePages) return;
                loadProductsPage(pageIndex + 1, pageStartCursors[pageIndex + 1] ?? null);
              }}
              disabled={loading || !hasMorePages}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      </PageContainer>
    </div>
  );
}
