import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import PageShell from "../layout/PageShell";
import AsyncError from "../shared/AsyncError";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { collectPaginatedProducts } from "../../services/paginatedExport";
import DataListTable from "../shared/DataListTable";
import Modal from "../shared/Modal";
import { Combobox } from "../ui/combobox";
import { productUnitLabel } from "../../utils/productUnitDisplay";
import { auth } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierProducts, importSupplierProducts } from "../../services/firebaseProducts";
import { getSuppliers } from "../../services/firebaseSuppliers";
import { usePermission } from "../../hooks/usePermission";
import { SUPPLIER_PRODUCT_EXPORT_HEADERS, SUPPLIER_PRODUCT_TEMPLATE_HEADERS, SUPPLIER_PRODUCT_TEMPLATE_ROW, supplierProductExportRow, parseSupplierProductRows } from "../../utils/supplierProductTransfer";
import SupplierProductImage from "../catalog/SupplierProductImage";
import SupplierAiImportDialog from "../catalog/SupplierAiImportDialog";
import { useSupplierAiImportProgress } from "../../contexts/SupplierAiImportProgressContext";
import { useSupplierProductAuthority } from "../../hooks/useSupplierProductAuthority";
import { formatOrderPriceBasis } from "../../utils/orderPricing";
import { ArticleRowsSkeleton } from "../ui/ResourceLoading";

const PAGE_SIZE = 50;
function resolveDisplayPrice(product) {
  const pricingModel = String(product?.pricingModel || "").trim();
  const rawPrice = pricingModel === "Per Base Unit" ? product?.pricePerBaseUnit : product?.pricePerPurchaseUnit;
  return typeof rawPrice === "number" && Number.isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : null;
}

function formatDisplayPrice(product) {
  const pricingModel = String(product?.pricingModel || "").trim();
  const isPerBaseUnit = pricingModel === "Per Base Unit";
  const unit = String(isPerBaseUnit ? product?.baseUnit || "" : product?.purchaseUnit || "").trim();
  const price = resolveDisplayPrice(product);
  if (price === null) return "Price unavailable";
  const formattedPrice = `${price} ${product.currency || "unknown currency"}`;
  return unit ? `${formattedPrice}/${unit}` : formattedPrice;
}

export default function SupplierProductsPage() {
  const { hotelUid } = useHotelContext();
  const authority = useSupplierProductAuthority();
  return <ScopedSupplierProductsPage key={authority} hotelUid={hotelUid} />;
}

function ScopedSupplierProductsPage({ hotelUid }) {
  const aiImportProgress = useSupplierAiImportProgress();
  const actorAtMount = useRef(auth.currentUser).current;
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && auth.currentUser === actorAtMount;
  const fileInputRef = useRef(null);
  const canCreateProducts = usePermission("supplierproducts", "create");
  const canReadSuppliers = usePermission("suppliers", "read");
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("");
  const [pageStartCursors, setPageStartCursors] = useState({ 0: null });
  const [showExportModal, setShowExportModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showImportChoice, setShowImportChoice] = useState(false);
  const [showAiImport, setShowAiImport] = useState(false);
  const [aiImportOpened, setAiImportOpened] = useState(false);
  const [pendingImportProducts, setPendingImportProducts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [importError, setImportError] = useState(null);
  const [importStatus, setImportStatus] = useState("");

  const supplierIdFilter = canReadSuppliers ? selectedSupplierId : "";
  const queryKey = `${hotelUid}:${debouncedSearchTerm}:${supplierIdFilter}:${selectedStatus}`;
  const loadProducts = useCallback(async (nextPageIndex = 0, cursor = null) => ({
    ...(await getSupplierProducts(hotelUid, { pageSize: PAGE_SIZE, cursor, searchTerm: debouncedSearchTerm, supplierId: supplierIdFilter, active: selectedStatus === "active" ? true : selectedStatus === "inactive" ? false : null })), pageIndex: nextPageIndex,
  }), [hotelUid, debouncedSearchTerm, supplierIdFilter, selectedStatus]);
  const query = useScopedAsync({ scopeKey: queryKey, enabled: Boolean(hotelUid), initialData: null, load: loadProducts });
  const products = query.data?.products || [];
  const loading = query.loading;
  const pageIndex = query.data?.pageIndex || 0;
  const hasMorePages = Boolean(query.data?.hasMore);
  const loadProductsPage = query.run;
  useEffect(() => { setPageStartCursors({ 0: null }); }, [queryKey]);
  useEffect(() => {
    if (query.data?.hasMore && query.data.cursor) setPageStartCursors((current) => ({ ...current, [query.data.pageIndex + 1]: query.data.cursor }));
  }, [query.data]);

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebouncedSearchTerm(searchTerm), 300);
    return () => clearTimeout(timeoutId);
  }, [searchTerm]);


  const loadSuppliers = useCallback(async () => (await getSuppliers(hotelUid)).map((supplier) => ({ id: String(supplier.id || "").trim(), name: String(supplier.name || "").trim() })).filter((supplier) => supplier.id).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)), [hotelUid]);
  const supplierQuery = useScopedAsync({ scopeKey: `${hotelUid}:${canReadSuppliers}`, enabled: Boolean(hotelUid && canReadSuppliers), initialData: [], load: loadSuppliers });
  const supplierFilters = (supplierQuery.data || []).map((supplier) => ({ ...supplier, name: supplier.name || "Unnamed supplier" }));
  const supplierName = (product) => product.supplierName || supplierFilters.find((supplier) => supplier.id === product.supplierId)?.name || "Supplier name unavailable";

  const columns = [
    { key: "image", label: "Image", sortable: false, render: (product) => <SupplierProductImage hotelUid={hotelUid} product={product} className="h-12 w-12 rounded-lg object-contain" /> },
    {
      key: "supplier",
      label: "Supplier Name",
      render: supplierName,
      sortValue: supplierName,
    },
    { key: "supplierSku", label: "Supplier SKU" },
    { key: "supplierProductName", label: "Supplier Product Name" },
    { key: "packageContent", label: "Supplier package content", sortable: false, render: (product) => <span className="text-sm">{typeof product.baseUnitsPerPurchaseUnit === "number" ? product.baseUnitsPerPurchaseUnit : "Unknown"} {productUnitLabel(product.baseUnit)}<span className="mt-1 block text-xs text-gray-500">per {product.purchaseUnit || "unknown purchase unit"}</span></span> },
    {
      key: "price",
      label: "Price",
      sortValue: (product) => resolveDisplayPrice(product),
      render: (product) => <span>{formatDisplayPrice(product)}<span className="mt-1 block text-xs text-gray-500">{formatOrderPriceBasis(product.priceBasis)}</span></span>,
    },
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

  const downloadExcel = async (rows, headers, filename) => {
    if (!current()) return;
    const XLSX = await import("xlsx");
    if (!current()) return;
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "SupplierProducts");
    XLSX.writeFile(workbook, filename);
  };

  const handleExportTemplate = async () => {
    try { await downloadExcel([SUPPLIER_PRODUCT_TEMPLATE_ROW], SUPPLIER_PRODUCT_TEMPLATE_HEADERS, "supplier-products-template.xlsx");
    if (current()) setShowExportModal(false); } catch (error) { if (current()) setExportError(error); }
  };

  const handleExportFullList = async () => {
    if (!current() || !hotelUid) return;
    setBusy(true); setExportError(null);
    try {
      const allProducts = await collectPaginatedProducts((options) => {
        if (!current()) throw new Error("The catalog page is no longer active.");
        return getSupplierProducts(hotelUid, options);
      });
      if (!current()) return;
      const rows = allProducts.map((product) => supplierProductExportRow(product));
      await downloadExcel(rows, SUPPLIER_PRODUCT_EXPORT_HEADERS, "supplier-products-full.xlsx");
      if (current()) setShowExportModal(false);
    } catch (error) { if (current()) setExportError(error); } finally { if (current()) setBusy(false); }
  };

  const handleImportButton = () => {
    if (!busy && canCreateProducts) setShowImportChoice(true);
  };

  const handleImportFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!current() || !file || !canCreateProducts) return;
    setImportError(null); setImportStatus("");
    setBusy(true);

    try {
      const workbookData = await file.arrayBuffer();
      if (!current()) return;
      const XLSX = await import("xlsx");
      if (!current()) return;
      const workbook = XLSX.read(workbookData, { type: "array" });
      const firstSheet = workbook.SheetNames[0];
      const worksheet = firstSheet ? workbook.Sheets[firstSheet] : null;
      if (!worksheet) {
        throw new Error("The workbook has no readable worksheet.");
      }

      const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "", raw: false });
      const importedProducts = parseSupplierProductRows(rows);

      setPendingImportProducts(importedProducts);
      setShowImportModal(true);
    } catch (error) {
      if (!current()) return;
      setImportError(error);
    } finally {
      if (current()) setBusy(false);
    }
  };

  const submitImport = async (onExisting) => {
    if (!current() || !hotelUid || !canCreateProducts || pendingImportProducts.length === 0) return;

    const actor =
      sessionStorage.getItem("userEmail") ||
      sessionStorage.getItem("userName") ||
      auth.currentUser?.email ||
      "unknown";

    setBusy(true); setImportError(null); setImportStatus("");
    try {
      const result = await importSupplierProducts(hotelUid, pendingImportProducts, {
        onExisting,
        actor,
      });
      if (!current()) return;
      setShowImportModal(false);
      setPendingImportProducts([]);
      setPageStartCursors({ 0: null });
      await loadProductsPage(0, null);
      if (!current()) return;
      setImportStatus(t("products.import.result", { imported: result.imported, skipped: result.skipped }));
    } catch (error) {
      if (!current()) return;
      setImportError(error);
    } finally {
      if (current()) setBusy(false);
    }
  };

  return (
    <PageShell variant="procurement">
        {!showImportModal && <AsyncError error={importError} label="Could not import supplier products." />}
        {importStatus && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{importStatus}</p>}
        <AsyncError error={query.error} onRetry={query.retry} label="Could not load products." />
        {canReadSuppliers && <AsyncError error={supplierQuery.error} onRetry={supplierQuery.retry} label="Could not load suppliers." />}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">{t("products.catalog")}</p>
            <h1 className="text-3xl font-semibold">Supplier Products</h1>
            <p className="text-gray-600 mt-1">{t("products.subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleImportButton}
              disabled={busy || !canCreateProducts}
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
                  ? "bg-brand-800 text-white hover:bg-brand-950"
                  : "bg-gray-300 text-gray-500 cursor-not-allowed"
              }`}
            >
              <Plus className="h-4 w-4" /> {t("products.actions.new")}
            </button>
          </div>
        </div>
        {canCreateProducts && canReadSuppliers && aiImportProgress?.jobs.length > 0 && <section aria-label="Recent supplier imports" className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Recent imports</h2><p className="text-xs text-stone-500">Private drafts from this session. Your review decisions are saved as you work.</p></div>
          <ul className="mt-3 space-y-2">{[...aiImportProgress.jobs].reverse().map((job) => <li key={job.jobId} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-stone-50 px-3 py-2">
            <div className="min-w-0"><p className="break-words text-sm font-medium">{job.source?.fileName || "Supplier document"}</p><p className="text-xs text-stone-500">{["uploading", "queued", "processing", "recovering"].includes(job.status) ? "Processing in the background" : job.status === "completed" ? "Import complete" : ["failed", "expired", "response_unknown"].includes(job.status) ? "Needs attention" : "Ready for review"}</p></div>
            <button type="button" className="ht-button-secondary shrink-0" onClick={() => aiImportProgress.openJob(job.jobId)}>Resume {job.source?.fileName || "import"}</button>
          </li>)}</ul>
        </section>}
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
            placeholder="Search by supplier name, supplier sku or product name"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-800/20"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {canReadSuppliers && <Combobox
            aria-label="Filter by supplier"
            value={supplierFilters.find((supplier) => supplier.id === selectedSupplierId) || null}
            options={supplierFilters}
            displayValue={(supplier) => supplier.name}
            getOptionValue={(supplier) => supplier.id}
            onChange={(supplier) => setSelectedSupplierId(supplier?.id || "")}
            placeholder="All suppliers"
            allowClear
            loading={supplierQuery.loading}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-800/20"
          />}

          <select
            value={selectedStatus}
            onChange={(event) => setSelectedStatus(event.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-800/20"
          >
            <option value="">All statuses</option>
            <option value="active">{t("products.status.active")}</option>
            <option value="inactive">{t("products.status.inactive")}</option>
          </select>
        </div>

        {loading ? (
          <ArticleRowsSkeleton rows={5} label="Preparing supplier products…" />
        ) : query.error ? null : (
          <DataListTable
            columns={columns}
            rows={products}
            onRowClick={(product) => navigate(`/catalog/supplier-products/${product.id}`)}
            emptyMessage={t("products.table.empty")}
          />
        )}

        <div className="flex flex-wrap items-center justify-between border-t border-gray-200 pt-4">
          <p className="text-sm text-gray-500">Page {pageIndex + 1}</p>
          <div className="flex flex-wrap items-center gap-2">
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

      <Modal open={showExportModal} onClose={() => setShowExportModal(false)} title={t("products.export.title")}>
        <p className="mb-4 text-sm text-gray-700">{t("products.export.message")}</p>
        <p className="mb-3 text-sm text-gray-600">The full export includes every product in this hotel, regardless of the current filters. Keep document IDs, revisions and purchase-option IDs when updating existing offers. Audit columns are read-only; managed uploads stay attached to the existing product.</p>
        <p className="mb-3 text-xs text-gray-500">GTINs and supplier SKUs are exported as text. Keep them as text in your spreadsheet to preserve leading zeroes. Blank prices, currencies and contract dates stay unknown.</p>
        <AsyncError error={exportError} onRetry={handleExportFullList} label="Could not export products." />
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
            disabled={busy}
            className="rounded-lg bg-brand-800 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-950"
          >
            {t("products.export.full")}
          </button>
        </div>
      </Modal>

      <Modal open={showImportChoice} onClose={() => setShowImportChoice(false)} title="Import supplier products">
        <div className="space-y-3">
          <p className="text-sm text-stone-600">Choose a prepared Hotel Toolkit template or ask AI to prepare a review from your supplier's document.</p>
          <button type="button" className="ht-button-secondary w-full" onClick={() => { setShowImportChoice(false); fileInputRef.current?.click(); }} disabled={busy || !canCreateProducts}>Template Import</button>
          <button type="button" className="ht-button-primary w-full" onClick={() => { setShowImportChoice(false); if (aiImportProgress) aiImportProgress.openNew({ suppliers: supplierFilters, suppliersLoading: supplierQuery.loading, initialSupplierId: selectedSupplierId, onImported: () => { if (!current()) return; setPageStartCursors({ 0: null }); loadProductsPage(0, null); } }); else { setAiImportOpened(true); setShowAiImport(true); } }} disabled={!canCreateProducts || !canReadSuppliers}>AI Import</button>
          {!canReadSuppliers && <p className="text-xs text-stone-500">AI import also requires access to this hotel's suppliers.</p>}
          <p className="text-xs text-stone-500">AI prepares a draft. Approve the products you want to include, then confirm the import on its review page.</p>
        </div>
      </Modal>
      {!aiImportProgress && aiImportOpened && <SupplierAiImportDialog open={showAiImport} onClose={() => setShowAiImport(false)} hotelUid={hotelUid} suppliers={supplierFilters} suppliersLoading={supplierQuery.loading} initialSupplierId={selectedSupplierId} onImported={() => { if (!current()) return; setPageStartCursors({ 0: null }); loadProductsPage(0, null); }} />}

      <Modal open={showImportModal} onClose={() => setShowImportModal(false)} title={t("products.import.title")}>
        <p className="mb-4 text-sm text-gray-700">{t("products.import.message")}</p>
        <p className="mb-3 text-sm text-gray-600">{pendingImportProducts.length} products are ready for validation. Existing product revisions are checked before overwriting; supplier, catalog and package identities remain protected.</p>
        <AsyncError error={importError} label="Could not import supplier products." />
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => submitImport("overwrite")}
            disabled={busy}
            className="rounded-lg bg-brand-800 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-950 disabled:opacity-50"
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
    </PageShell>
  );
}
