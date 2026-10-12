import React, { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import ProductFormFields from "./ProductFormFields";
import PendingProductCommand from "../catalog/PendingProductCommand";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getCatalogProduct, updateCatalogProduct } from "../../services/firebaseProducts";

function ScopedProductEditPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { productId } = useParams();
  const { hotelUid } = useHotelContext();
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

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
    let active = true;
    setLoading(true); setLoadError("");
    if (!hotelUid || !productId) { setLoading(false); return; }
    getCatalogProduct(hotelUid, productId)
      .then((data) => { if (active) setProduct(data); })
      .catch((error) => { if (active) setLoadError(error?.message || "Could not load this product."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [hotelUid, productId]);

  const handleUpdate = async (payload) => {
    const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
    await updateCatalogProduct(hotelUid, productId, payload, actor, { expectedRevision: product?.revision ?? 0 });
    if (mounted.current) navigate(`/catalog/products/${productId}`);
  };

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage width="form" className="space-y-6">
        <PendingProductCommand hotelUid={hotelUid} collection="catalogproducts" productId={productId} onComplete={(result) => { if (mounted.current) navigate(`/catalog/products/${result.productId}`); }} />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">{t("products.catalog")}</p>
            <h1 className="text-3xl font-semibold">{t("products.edit.title")}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/catalog/products/${productId}`)}
              className="px-4 py-2 rounded border border-gray-300 font-semibold text-gray-700"
            >
              {t("products.actions.backToDetail")}
            </button>
            <button
              type="button"
              onClick={() => navigate("/catalog/products")}
              className="px-4 py-2 rounded border border-gray-300 font-semibold text-gray-700"
            >
              {t("products.actions.backToProducts")}
            </button>
          </div>
        </div>

        {loadError ? <p role="alert" className="text-red-700">{loadError}</p> : loading ? (
          <p className="text-gray-600">{t("products.loading")}</p>
        ) : !product ? (
          <Card>
            <p className="text-gray-600">{t("products.notFound")}</p>
          </Card>
        ) : (
          <>
            <Card>
              <div className="grid gap-6 md:grid-cols-[220px_1fr] items-start">
                <div className="rounded-xl overflow-hidden bg-gray-100 border border-gray-200 shadow-sm">
                  {product.imageUrl ? (
                    <img
                      src={product.imageUrl}
                      alt={product.name || "Product"}
                      className="h-56 w-full object-cover"
                    />
                  ) : (
                    <div className="h-56 flex items-center justify-center text-gray-500 text-sm">
                      {t("products.detail.noImage")}
                    </div>
                  )}
                </div>
                <div>
                  <h2 className="text-2xl font-semibold text-gray-900">{product.name || "-"}</h2>
                  <p className="text-gray-600 mt-1">{product.brand || "-"}</p>
                  <p className="mt-3 text-sm text-gray-700">{product.description || "-"}</p>
                </div>
              </div>
            </Card>

            <Card>
              <ProductFormFields
                hotelUid={hotelUid}
                initialData={product}
                onSubmit={handleUpdate}
                savingLabel={t("products.actions.saving")}
                submitLabel={t("products.actions.saveChanges")}
                showImagePreview={false}
              />
            </Card>
          </>
        )}
      </ProcurementPage>
    </div>
  );
}

export default function ProductEditPage() {
  const { hotelUid } = useHotelContext();
  const { productId } = useParams();
  return <ScopedProductEditPage key={`${hotelUid}:${productId}`} />;
}
