import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getCatalogProducts } from "../../services/firebaseProducts";
import { usePermission } from "../../hooks/usePermission";

export default function ProductsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { hotelUid } = useHotelContext();
  const canCreateProducts = usePermission("products", "create");
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [selectedSubcategory, setSelectedSubcategory] = useState("");

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
    const loadProducts = async () => {
      if (!hotelUid) return;
      setLoading(true);
      const result = await getCatalogProducts(hotelUid);
      setProducts(result);
      setLoading(false);
    };
    loadProducts();
  }, [hotelUid]);

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
    const term = searchTerm.trim().toLowerCase();
    return products.filter((product) => {
      const name = String(product.name || "").toLowerCase();
      const brand = String(product.brand || "").toLowerCase();
      const category = String(product.category || "");
      const subcategory = String(product.subcategory || "");

      const matchesTerm = !term || name.includes(term) || brand.includes(term);
      const matchesCategory = !selectedCategory || category === selectedCategory;
      const matchesSubcategory = !selectedSubcategory || subcategory === selectedSubcategory;

      return matchesTerm && matchesCategory && matchesSubcategory;
    });
  }, [products, searchTerm, selectedCategory, selectedSubcategory]);

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
          {canCreateProducts && (
            <button
              onClick={() => navigate("/catalog/products/new")}
              className="inline-flex items-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919]"
            >
              <Plus className="h-4 w-4" /> {t("products.actions.new")}
            </button>
          )}
        </div>

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
          <DataListTable
            columns={columns}
            rows={filteredProducts}
            onRowClick={(product) => navigate(`/catalog/products/${product.id}`)}
            emptyMessage={t("products.table.empty")}
          />
        )}
      </PageContainer>
    </div>
  );
}
