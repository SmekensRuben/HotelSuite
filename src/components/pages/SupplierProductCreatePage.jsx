import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import ProductFormFields from "./ProductFormFields";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createSupplierProduct, uploadSupplierProductImage } from "../../services/firebaseProducts";

export default function SupplierProductCreatePage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { hotelUid } = useHotelContext();

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
    const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
    const productId = await createSupplierProduct(hotelUid, payload, actor);
    navigate(`/catalog/supplier-products/${productId}`);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">{t("products.catalog")}</p>
          <h1 className="text-3xl font-semibold">New Supplier Product</h1>
        </div>

        <Card>
          <ProductFormFields
            hotelUid={hotelUid}
            onSubmit={handleCreate}
            savingLabel={t("products.actions.saving")}
            submitLabel={t("products.actions.create")}
            uploadImage={uploadSupplierProductImage}
          />
        </Card>
      </PageContainer>
    </div>
  );
}
