import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getCatalogProduct } from "../../services/firebaseProducts";

function formatDate(value) {
  if (!value) return "-";
  if (typeof value?.toDate === "function") {
    return value.toDate().toLocaleString();
  }
  if (typeof value?.seconds === "number") {
    return new Date(value.seconds * 1000).toLocaleString();
  }
  return String(value);
}

function DetailField({ label, value }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-sm text-gray-800 mt-1">{value || "-"}</p>
    </div>
  );
}

export default function ProductDetailPage() {
  const navigate = useNavigate();
  const { productId } = useParams();
  const { hotelUid } = useHotelContext();
  const [product, setProduct] = useState(null);
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
    const loadProduct = async () => {
      if (!hotelUid || !productId) return;
      setLoading(true);
      const data = await getCatalogProduct(hotelUid, productId);
      setProduct(data);
      setLoading(false);
    };
    loadProduct();
  }, [hotelUid, productId]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
            <h1 className="text-3xl font-semibold">Product detail</h1>
          </div>
          <button
            type="button"
            onClick={() => navigate("/catalog/products")}
            className="px-4 py-2 rounded border border-gray-300 font-semibold text-gray-700"
          >
            Terug naar Products
          </button>
        </div>

        {loading ? (
          <p className="text-gray-600">Product laden...</p>
        ) : !product ? (
          <Card>
            <p className="text-gray-600">Product niet gevonden.</p>
          </Card>
        ) : (
          <div className="space-y-4">
            <Card>
              <h2 className="text-lg font-semibold mb-3">Identity</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <DetailField label="Name" value={product.name} />
                <DetailField label="Brand" value={product.brand} />
                <DetailField label="Description" value={product.description} />
                <DetailField label="Active" value={product.active !== false ? "Ja" : "Nee"} />
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Classification</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="Category" value={product.category} />
                <DetailField label="Subcategory" value={product.subcategory} />
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Units & Normalisation</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="Base Unit" value={product.baseUnit} />
                <DetailField label="Base Qty Per Unit" value={product.baseQtyPerUnit} />
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Identifiers</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="GTIN" value={product.gtin} />
                <DetailField label="Internal SKU" value={product.internalSku} />
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Storage & Operationally</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="Storage Type" value={product.storageType} />
                <DetailField
                  label="Allergens"
                  value={Array.isArray(product.allergens) ? product.allergens.join(", ") : ""}
                />
                <DetailField label="Notes" value={product.notes} />
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Audit / Metadata</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="Created At" value={formatDate(product.createdAt)} />
                <DetailField label="Created By" value={product.createdBy} />
                <DetailField label="Updated At" value={formatDate(product.updatedAt)} />
                <DetailField label="Updated By" value={product.updatedBy} />
              </div>
            </Card>
          </div>
        )}
      </PageContainer>
    </div>
  );
}
