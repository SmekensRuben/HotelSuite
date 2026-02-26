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
import { getCatalogProducts, importCatalogProducts } from "../../services/firebaseProducts";
import { usePermission } from "../../hooks/usePermission";

const EXCEL_HEADERS = [
  "documentId",
  "name",
  "brand",
  "description",
  "active",
  "category",
  "subcategory",
  "baseUnit",
  "baseQtyPerUnit",
  "gtin",
  "internalSku",
  "storageType",
  "allergens",
  "notes",
  "imageUrl",
];

const TEMPLATE_HEADERS = EXCEL_HEADERS.filter((header) => header !== "documentId");

const EXPORT_TEMPLATE_ROW = {
  name: "",
  brand: "",
  description: "",
  active: "true",
  category: "",
  subcategory: "",
  baseUnit: "",
  baseQtyPerUnit: "1",
  gtin: "",
  internalSku: "",
  storageType: "",
  allergens: "",
  notes: "",
  imageUrl: "",
};

const PAGE_SIZE = 50;

export default function ProductsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { hotelUid } = useHotelContext();
  const fileInputRef = useRef(null);
  const canCreateProducts = usePermission("catalogproducts", "create");
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [selectedSubcategory, setSelectedSubcategory] = useState("");
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
    const result = await getCatalogProducts(hotelUid, {
      pageSize: PAGE_SIZE,
      cursor,
      searchTerm: debouncedSearchTerm,
      category: selectedCategory,
      subcategory: selectedSubcategory,
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
    const timeoutId = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [searchTerm]);

  useEffect(() => {
    if (!hotelUid) return;

    setPageStartCursors({ 0: null });
    loadProductsPage(0, null);
  }, [hotelUid, debouncedSearchTerm, selectedCategory, selectedSubcategory]);

  const categories = useMemo(() => {
    const values = new Set(
      products
        .map((product) => String(product.category || "").trim())
        .filter(Boolean)
    );
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [products]);

  const subcategories = useMemo(() => {
    const values = new Set(
      products
        .filter((product) => !selectedCategory || String(product.category || "") === selectedCategory)
        .map((product) => String(product.subcategory || "").trim())
        .filter(Boolean)
    );
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [products, selectedCategory]);

  useEffect(() => {
    if (selectedSubcategory && !subcategories.includes(selectedSubcategory)) {
      setSelectedSubcategory("");
    }
  }, [selectedSubcategory, subcategories]);

  const filteredProducts = useMemo(() => {
    return products.filter((product) => {
      const category = String(product.category || "");
      const subcategory = String(product.subcategory || "");

      const matchesCategory = !selectedCategory || category === selectedCategory;
      const matchesSubcategory = !selectedSubcategory || subcategory === selectedSubcategory;

      return matchesCategory && matchesSubcategory;
    });
  }, [products, selectedCategory, selectedSubcategory]);

  const columns = [
    { key: "name", label: t("products.columns.name") },
    { key: "brand", label: t("products.columns.brand") },
    { key: "category", label: t("products.columns.category") },
    { key: "subcategory", label: t("products.columns.subcategory") },
    { key: "baseUnit", label: t("products.columns.baseUnit") },
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
    XLSX.utils.book_append_sheet(workbook, worksheet, "Products");
    XLSX.writeFile(workbook, filename);
  };

  const normalizeExportRow = (row) => ({
    documentId: row.documentId || row.id || "",
    name: row.name || "",
    brand: row.brand || "",
    description: row.description || "",
    active: row.active !== false ? "true" : "false",
    category: row.category || "",
    subcategory: row.subcategory || "",
    baseUnit: row.baseUnit || "",
    baseQtyPerUnit: row.baseQtyPerUnit ?? "",
    gtin: row.gtin || "",
    internalSku: row.internalSku || "",
    storageType: row.storageType || "",
    allergens: Array.isArray(row.allergens) ? row.allergens.join("|") : row.allergens || "",
    notes: row.notes || "",
    imageUrl: row.imageUrl || "",
  });

  const handleExportTemplate = () => {
    downloadExcel([EXPORT_TEMPLATE_ROW], TEMPLATE_HEADERS, "catalog-products-template.xlsx");
    setShowExportModal(false);
  };

  const handleExportFullList = () => {
    const rows = products.map((product) => normalizeExportRow({ documentId: product.id, ...product }));
    downloadExcel(rows, EXCEL_HEADERS, "catalog-products-full.xlsx");
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

          return {
            documentId: String(row.documentId || "").trim() || undefined,
            name: String(row.name || "").trim(),
            brand: String(row.brand || "").trim(),
            description: String(row.description || "").trim(),
            active: String(row.active || "").trim().toLowerCase() !== "false",
            category: String(row.category || "").trim(),
            subcategory: String(row.subcategory || "").trim(),
            baseUnit: String(row.baseUnit || "").trim(),
            baseQtyPerUnit: parseNumberOrUndefined(row.baseQtyPerUnit),
            gtin: String(row.gtin || "").trim(),
            internalSku: String(row.internalSku || "").trim(),
            storageType: String(row.storageType || "").trim(),
            allergens: String(row.allergens || "")
              .split("|")
              .map((item) => item.trim())
              .filter(Boolean),
            notes: String(row.notes || "").trim(),
            imageUrl: String(row.imageUrl || "").trim(),
          };
        })
        .filter(Boolean);

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
      const result = await importCatalogProducts(hotelUid, pendingImportProducts, {
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
            <h1 className="text-3xl font-semibold">{t("products.title")}</h1>
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
              onClick={() => navigate("/catalog/products/new")}
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

        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className="sr-only" htmlFor="products-search">
              {t("products.filter.label")}
            </label>
            <input
              id="products-search"
              type="text"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={t("products.filter.placeholder")}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
            />
          </div>
          <div>
            <label className="sr-only" htmlFor="products-category-filter">
              {t("products.filter.category")}
            </label>
            <select
              id="products-category-filter"
              value={selectedCategory}
              onChange={(event) => setSelectedCategory(event.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
            >
              <option value="">{t("products.filter.allCategories")}</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="sr-only" htmlFor="products-subcategory-filter">
              {t("products.filter.subcategory")}
            </label>
            <select
              id="products-subcategory-filter"
              value={selectedSubcategory}
              onChange={(event) => setSelectedSubcategory(event.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
            >
              <option value="">{t("products.filter.allSubcategories")}</option>
              {subcategories.map((subcategory) => (
                <option key={subcategory} value={subcategory}>
                  {subcategory}
                </option>
              ))}
            </select>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-600">{t("products.loading")}</p>
        ) : (
          <>
            <DataListTable
              columns={columns}
              rows={filteredProducts}
              onRowClick={(product) => navigate(`/catalog/products/${product.id}`)}
              emptyMessage={t("products.table.empty")}
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-gray-500">
                Pagina {pageIndex + 1} · Max. {PAGE_SIZE} producten per pagina{debouncedSearchTerm.trim() ? " · Server-side naamfilter actief" : ""}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (pageIndex === 0) return;
                    const previousPage = pageIndex - 1;
                    const previousCursor = pageStartCursors[previousPage] || null;
                    loadProductsPage(previousPage, previousCursor);
                  }}
                  disabled={pageIndex === 0 || loading}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Vorige
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!hasMorePages) return;
                    const nextPage = pageIndex + 1;
                    const nextCursor = pageStartCursors[nextPage] || null;
                    loadProductsPage(nextPage, nextCursor);
                  }}
                  disabled={!hasMorePages || loading}
                  className="rounded-lg border border-[#b41f1f] bg-[#b41f1f] px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Volgende
                </button>
              </div>
            </div>
          </>
        )}
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
