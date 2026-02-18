import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getCatalogProducts } from "../../services/firebaseProducts";

export default function ProductsPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);

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

  const columns = [
    { key: "name", label: "Naam" },
    { key: "brand", label: "Merk" },
    { key: "category", label: "Categorie" },
    { key: "subcategory", label: "Subcategorie" },
    { key: "baseUnit", label: "Base Unit" },
    {
      key: "active",
      label: "Status",
      render: (product) => (
        <span
          className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
            product.active !== false
              ? "bg-green-100 text-green-700"
              : "bg-gray-200 text-gray-700"
          }`}
        >
          {product.active !== false ? "Actief" : "Inactief"}
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
            <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
            <h1 className="text-3xl font-semibold">Products</h1>
            <p className="text-gray-600 mt-1">Overzicht van alle producten.</p>
          </div>
          <button
            onClick={() => navigate("/catalog/products/new")}
            className="inline-flex items-center gap-2 rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#961919]"
          >
            <Plus className="h-4 w-4" /> Nieuw product
          </button>
        </div>

        {loading ? (
          <p className="text-gray-600">Products laden...</p>
        ) : (
          <DataListTable
            columns={columns}
            rows={products}
            onRowClick={(product) => navigate(`/catalog/products/${product.id}`)}
            emptyMessage="Nog geen products aangemaakt."
          />
        )}
      </PageContainer>
    </div>
  );
}
