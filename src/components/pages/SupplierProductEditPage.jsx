import React, { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import SupplierProductFormFields from "./SupplierProductFormFields";
import PendingProductCommand from "../catalog/PendingProductCommand";
import SupplierProductSavedImage from "../catalog/SupplierProductSavedImage";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierProduct, updateSupplierProduct, getPendingProductCommand } from "../../services/firebaseProducts";
import { useSupplierProductAuthority } from "../../hooks/useSupplierProductAuthority";
import { LoadingStatus } from "../ui/ResourceLoading";

function ScopedSupplierProductEditPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { productId } = useParams();
  const { hotelUid } = useHotelContext();
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saved, setSaved] = useState(null);
  const [pending, setPending] = useState(false);
  const imageRequest = useRef(null);

  const mounted = useRef(true);
  const actorAtMount = useRef(auth.currentUser).current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const refresh = () => setPending(Boolean(getPendingProductCommand(hotelUid, "supplierproducts", productId)));
    refresh(); window.addEventListener("product-command-changed", refresh);
    return () => window.removeEventListener("product-command-changed", refresh);
  }, [hotelUid, productId]);

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

  const complete = (updatedProductId) => {
    if (!mounted.current || auth.currentUser !== actorAtMount) return;
    if (imageRequest.current?.file) setSaved({ product: { ...product, id: updatedProductId, supplierProductName: imageRequest.current.name }, file: imageRequest.current.file });
    else navigate(`/catalog/supplier-products/${updatedProductId}`);
  };
  const handleUpdate = async (payload, file) => {
    if (!mounted.current || auth.currentUser !== actorAtMount) throw new Error("Hotel access changed. Reload before changing a product.");
    imageRequest.current = { file, name: payload.supplierProductName };
    const updatedProductId = await updateSupplierProduct(hotelUid, productId, payload, undefined, { expectedRevision: product?.revision ?? 0 });
    complete(updatedProductId);
  };

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage width="form" className="space-y-6">
        <PendingProductCommand hotelUid={hotelUid} collection="supplierproducts" productId={productId} onComplete={(result) => complete(result.productId)} />
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
          <LoadingStatus>Preparing supplier product…</LoadingStatus>
        ) : !product ? (
          <Card>
            <p className="text-gray-600">{t("products.notFound")}</p>
          </Card>
        ) : (
          <>
            <Card>
              {saved ? <SupplierProductSavedImage hotelUid={hotelUid} product={saved.product} file={saved.file} onOpen={() => { if (mounted.current && auth.currentUser === actorAtMount) navigate(`/catalog/supplier-products/${saved.product.id}`); }} /> : <SupplierProductFormFields
            key={hotelUid}
                initialData={product}
                onSubmit={handleUpdate}
                savingLabel={t("products.actions.saving")}
                submitLabel={t("products.actions.saveChanges")}
                disabled={pending}
              />}
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
  const authority = useSupplierProductAuthority();
  return <ScopedSupplierProductEditPage key={`${hotelUid}:${productId}:${authority}`} />;
}
