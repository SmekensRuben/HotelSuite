import React, { useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import SupplierProductFormFields from "./SupplierProductFormFields";
import PendingProductCommand from "../catalog/PendingProductCommand";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createSupplierProduct } from "../../services/firebaseProducts";

function ScopedSupplierProductCreatePage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { hotelUid } = useHotelContext();

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

  const handleCreate = async (payload) => {
    const productId = await createSupplierProduct(hotelUid, payload);
    if (mounted.current) navigate(`/catalog/supplier-products/${productId}`);
  };

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <PendingProductCommand hotelUid={hotelUid} collection="supplierproducts" productId={"create"} onComplete={(result) => { if (mounted.current) navigate(`/catalog/supplier-products/${result.productId}`); }} />
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">{t("products.catalog")}</p>
          <h1 className="text-3xl font-semibold">New Supplier Product</h1>
        </div>

        <Card>
          <SupplierProductFormFields
            key={hotelUid}
            onSubmit={handleCreate}
            savingLabel={t("products.actions.saving")}
            submitLabel={t("products.actions.create")}
          />
        </Card>
      </PageContainer>

    </div>
  );
}

export default function SupplierProductCreatePage() {
  const { hotelUid } = useHotelContext();
  return <ScopedSupplierProductCreatePage key={hotelUid} />;
}
