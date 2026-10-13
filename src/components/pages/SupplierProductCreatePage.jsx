import React, { useMemo, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import SupplierProductFormFields from "./SupplierProductFormFields";
import PendingProductCommand from "../catalog/PendingProductCommand";
import SupplierProductSavedImage from "../catalog/SupplierProductSavedImage";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createSupplierProduct, getPendingProductCommand } from "../../services/firebaseProducts";
import { useSupplierProductAuthority } from "../../hooks/useSupplierProductAuthority";

function ScopedSupplierProductCreatePage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { hotelUid } = useHotelContext();

  const mounted = useRef(true);
  const actorAtMount = useRef(auth.currentUser).current;
  const imageRequest = useRef(null);
  const [saved, setSaved] = useState(null), [pending, setPending] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const refresh = () => setPending(Boolean(getPendingProductCommand(hotelUid, "supplierproducts", "create")));
    refresh(); window.addEventListener("product-command-changed", refresh);
    return () => window.removeEventListener("product-command-changed", refresh);
  }, [hotelUid]);

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

  const complete = (productId) => {
    if (!mounted.current || auth.currentUser !== actorAtMount) return;
    if (imageRequest.current?.file) setSaved({ product: { id: productId, supplierProductName: imageRequest.current.name, imageRevision: 0 }, file: imageRequest.current.file });
    else navigate(`/catalog/supplier-products/${productId}`);
  };
  const handleCreate = async (payload, file) => {
    if (!mounted.current || auth.currentUser !== actorAtMount) throw new Error("Hotel access changed. Reload before creating a product.");
    imageRequest.current = { file, name: payload.supplierProductName };
    const productId = await createSupplierProduct(hotelUid, payload);
    complete(productId);
  };

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage width="form" className="space-y-6">
        <PendingProductCommand hotelUid={hotelUid} collection="supplierproducts" productId={"create"} onComplete={(result) => complete(result.productId)} />
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">{t("products.catalog")}</p>
          <h1 className="text-3xl font-semibold">New Supplier Product</h1>
        </div>

        <Card>
          {saved ? <SupplierProductSavedImage hotelUid={hotelUid} product={saved.product} file={saved.file} onOpen={() => { if (mounted.current && auth.currentUser === actorAtMount) navigate(`/catalog/supplier-products/${saved.product.id}`); }} /> : <SupplierProductFormFields
            key={hotelUid}
            onSubmit={handleCreate}
            savingLabel={t("products.actions.saving")}
            submitLabel={t("products.actions.create")}
            disabled={pending}
          />}
        </Card>
      </ProcurementPage>

    </div>
  );
}

export default function SupplierProductCreatePage() {
  const { hotelUid } = useHotelContext();
  const authority = useSupplierProductAuthority();
  return <ScopedSupplierProductCreatePage key={`${hotelUid}:${authority}`} />;
}
