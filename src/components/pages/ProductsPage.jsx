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

export default function ProductsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { hotelUid } = useHotelContext();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");

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

  const filteredProducts = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return products;
    return products.filter((product) => {
      const name = String(product.name || "").toLowerCase();
      const brand = String(product.brand || "").toLowerCase();
      return name.includes(term) || brand.includes(term);
    });
  }, [products, searchTerm]);

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
          <button
            onClick={() => navigate("/catalog/products/new")}
            className="inline-flex items-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919]"
          >
            <Plus className="h-4 w-4" /> {t("products.actions.new")}
          </button>
        </div>

        <div className="max-w-md">
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
