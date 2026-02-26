import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import * as XLSX from "xlsx";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import Modal from "../shared/Modal";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierProducts, importSupplierProducts } from "../../services/firebaseProducts";
import { usePermission } from "../../hooks/usePermission";

const PAGE_SIZE = 50;
const EXCEL_HEADERS = [
  "documentId",
  "supplierId",
  "supplierSku",
  "supplierProductName",
  "currency",
  "pricingModel",
  "pricePerBaseUnit",
  "pricePerPurchaseUnit",
  "purchaseUnit",
  "baseUnit",
  "baseUnitsPerPurchaseUnit",
  "catalogProductId",
  "active",
  "hasVariants",
  "variants",
];

const TEMPLATE_HEADERS = EXCEL_HEADERS.filter((header) => header !== "documentId");

const EXPORT_TEMPLATE_ROW = {
  supplierId: "",
  supplierSku: "",
  supplierProductName: "",
  currency: "EUR",
  pricingModel: "Per Purchase Unit",
  pricePerBaseUnit: "",
  pricePerPurchaseUnit: "",
  purchaseUnit: "",
  baseUnit: "",
  baseUnitsPerPurchaseUnit: "",
  catalogProductId: "",
  active: "true",
  hasVariants: "false",
  variants: "",
};

export default function SupplierProductsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { hotelUid } = useHotelContext();
  const fileInputRef = useRef(null);
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
  const [showExportModal, setShowExportModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [pendingImportProducts, setPendingImportProducts] = useState([]);
  const [busy, setBusy] = useState(false);

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

  const downloadExcel = (rows, headers, filename) => {
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "SupplierProducts");
    XLSX.writeFile(workbook, filename);
  };

  const normalizeExportRow = (row) => ({
    documentId: row.documentId || row.id || "",
    supplierId: row.supplierId || "",
    supplierSku: row.supplierSku || "",
    supplierProductName: row.supplierProductName || "",
    currency: row.currency || "EUR",
    pricingModel: row.pricingModel || "",
    pricePerBaseUnit: row.pricePerBaseUnit ?? "",
    pricePerPurchaseUnit: row.pricePerPurchaseUnit ?? "",
    purchaseUnit: row.purchaseUnit || "",
    baseUnit: row.baseUnit || "",
    baseUnitsPerPurchaseUnit: row.baseUnitsPerPurchaseUnit ?? "",
    catalogProductId: row.catalogProductId || "",
    active: row.active !== false ? "true" : "false",
    hasVariants: row.hasVariants ? "true" : "false",
    variants: Array.isArray(row.variants) ? JSON.stringify(row.variants) : "",
  });

  const handleExportTemplate = () => {
    downloadExcel([EXPORT_TEMPLATE_ROW], TEMPLATE_HEADERS, "supplier-products-template.xlsx");
    setShowExportModal(false);
  };

  const handleExportFullList = () => {
    const rows = products.map((product) => normalizeExportRow({ documentId: product.id, ...product }));
    downloadExcel(rows, EXCEL_HEADERS, "supplier-products-full.xlsx");
    setShowExportModal(false);
  };

  const handleImportButton = () => {
    if (!busy) fileInputRef.current?.click();
  };

  const handleImportFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const workbookData = await file.arrayBuffer();
      const workbook = XLSX.read(workbookData, { type: "array" });
      const firstSheet = workbook.SheetNames[0];
      const worksheet = firstSheet ? workbook.Sheets[firstSheet] : null;
      if (!worksheet) {
        window.alert(t("products.import.invalidFile"));
        return;
      }

      const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "", raw: false });
      const parseNumberOrUndefined = (value) => {
        const normalized = String(value || "").trim().replace(",", ".");
        if (!normalized) return undefined;
        const parsed = Number(normalized);
        return Number.isNaN(parsed) ? undefined : parsed;
      };

      const importedProducts = rows
        .map((row) => {
          const hasData = Object.values(row).some((value) => String(value ?? "").trim() !== "");
          if (!hasData) return null;

          let parsedVariants = [];
          const variantsRaw = String(row.variants || "").trim();
          if (variantsRaw) {
            try {
              const variantsJson = JSON.parse(variantsRaw);
              parsedVariants = Array.isArray(variantsJson) ? variantsJson : [];
            } catch {
              parsedVariants = [];
            }
          }

          return {
            documentId: String(row.documentId || "").trim() || undefined,
            supplierId: String(row.supplierId || "").trim(),
            supplierSku: String(row.supplierSku || "").trim(),
            supplierProductName: String(row.supplierProductName || "").trim(),
            currency: String(row.currency || "").trim() || "EUR",
            pricingModel: String(row.pricingModel || "").trim(),
            pricePerBaseUnit: parseNumberOrUndefined(row.pricePerBaseUnit),
            pricePerPurchaseUnit: parseNumberOrUndefined(row.pricePerPurchaseUnit),
            purchaseUnit: String(row.purchaseUnit || "").trim(),
            baseUnit: String(row.baseUnit || "").trim(),
            baseUnitsPerPurchaseUnit: parseNumberOrUndefined(row.baseUnitsPerPurchaseUnit),
            catalogProductId: String(row.catalogProductId || "").trim(),
            active: String(row.active || "").trim().toLowerCase() !== "false",
            hasVariants: String(row.hasVariants || "").trim().toLowerCase() === "true",
            variants: parsedVariants,
          };
        })
        .filter((product) => product && product.supplierId && product.supplierSku);

      if (importedProducts.length === 0) {
        window.alert(t("products.import.invalidFile"));
        return;
      }

      setPendingImportProducts(importedProducts);
      setShowImportModal(true);
    } catch (error) {
      console.error("Failed to parse import file", error);
      window.alert(t("products.import.invalidFile"));
    }
  };

  const submitImport = async (onExisting) => {
    if (!hotelUid || pendingImportProducts.length === 0) return;

    const actor =
      sessionStorage.getItem("userEmail") ||
      sessionStorage.getItem("userName") ||
      auth.currentUser?.email ||
      "unknown";

    setBusy(true);
    try {
      const result = await importSupplierProducts(hotelUid, pendingImportProducts, {
        onExisting,
        actor,
      });
      setShowImportModal(false);
      setPendingImportProducts([]);
      setPageStartCursors({ 0: null });
      await loadProductsPage(0, null);
      window.alert(
        t("products.import.result", {
          imported: result.imported,
          skipped: result.skipped,
        })
      );
    } catch (error) {
      console.error("Failed to import products", error);
      window.alert(t("products.import.failed"));
    } finally {
      setBusy(false);
    }
  };

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
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleImportButton}
              disabled={busy}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("products.actions.import")}
            </button>
            <button
              type="button"
              onClick={() => setShowExportModal(true)}
              disabled={busy}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("products.actions.export")}
            </button>
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
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          className="hidden"
          onChange={handleImportFileChange}
        />

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

      <Modal open={showExportModal} onClose={() => setShowExportModal(false)} title={t("products.export.title")}>
        <button
          type="button"
          onClick={() => setShowExportModal(false)}
          className="absolute right-4 top-4 rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          aria-label={t("products.actions.cancel")}
        >
          <X className="h-4 w-4" />
        </button>
        <p className="mb-4 text-sm text-gray-700">{t("products.export.message")}</p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleExportTemplate}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {t("products.export.template")}
          </button>
          <button
            type="button"
            onClick={handleExportFullList}
            className="rounded-lg bg-[#b41f1f] px-3 py-2 text-sm font-semibold text-white hover:bg-[#961919]"
          >
            {t("products.export.full")}
          </button>
        </div>
      </Modal>

      <Modal open={showImportModal} onClose={() => setShowImportModal(false)} title={t("products.import.title")}>
        <p className="mb-4 text-sm text-gray-700">{t("products.import.message")}</p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => submitImport("overwrite")}
            disabled={busy}
            className="rounded-lg bg-[#b41f1f] px-3 py-2 text-sm font-semibold text-white hover:bg-[#961919] disabled:opacity-50"
          >
            {t("products.import.overwrite")}
          </button>
          <button
            type="button"
            onClick={() => submitImport("skip")}
            disabled={busy}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {t("products.import.skip")}
          </button>
        </div>
      </Modal>
    </div>
  );
}
