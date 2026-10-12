import React, { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import SupplierProductFormFields from "./SupplierProductFormFields";
import PendingProductCommand from "../catalog/PendingProductCommand";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierProduct, updateSupplierProduct } from "../../services/firebaseProducts";

function ScopedSupplierProductEditPage() {
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
    getSupplierProduct(hotelUid, productId)
      .then((data) => { if (active) setProduct(data); })
      .catch((error) => { if (active) setLoadError(error?.message || "Could not load this product."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [hotelUid, productId]);

  const handleUpdate = async (payload) => {
    const updatedProductId = await updateSupplierProduct(hotelUid, productId, payload, undefined, { expectedRevision: product?.revision ?? 0 });
    if (mounted.current) navigate(`/catalog/supplier-products/${updatedProductId}`);
  };

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage width="form" className="space-y-6">
        <PendingProductCommand hotelUid={hotelUid} collection="supplierproducts" productId={productId} onComplete={(result) => { if (mounted.current) navigate(`/catalog/supplier-products/${result.productId}`); }} />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">{t("products.catalog")}</p>
            <h1 className="text-3xl font-semibold">Edit Supplier Product</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/catalog/supplier-products/${productId}`)}
              className="px-4 py-2 rounded border border-gray-300 font-semibold text-gray-700"
            >
              {t("products.actions.backToDetail")}
            </button>
            <button
              type="button"
              onClick={() => navigate("/catalog/supplier-products")}
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
              <SupplierProductFormFields
            key={hotelUid}
                initialData={product}
                onSubmit={handleUpdate}
                savingLabel={t("products.actions.saving")}
                submitLabel={t("products.actions.saveChanges")}
              />
            </Card>
          </>
        )}
      </ProcurementPage>

    </div>
  );
}

export default function SupplierProductEditPage() {
  const { hotelUid } = useHotelContext();
  const { productId } = useParams();
  return <ScopedSupplierProductEditPage key={`${hotelUid}:${productId}`} />;
}
