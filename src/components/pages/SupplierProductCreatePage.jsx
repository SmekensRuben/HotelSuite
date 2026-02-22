import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import SupplierProductFormFields from "./SupplierProductFormFields";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createSupplierProduct } from "../../services/firebaseProducts";

export default function SupplierProductCreatePage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { hotelUid } = useHotelContext();
  const [showOverwriteModal, setShowOverwriteModal] = useState(false);
  const [pendingPayload, setPendingPayload] = useState(null);

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
    const actor = auth.currentUser?.uid || "unknown";
    try {
      const productId = await createSupplierProduct(hotelUid, payload, actor);
      navigate(`/catalog/supplier-products/${productId}`);
    } catch (error) {
      if (error?.code === "supplier-product-exists") {
        setPendingPayload(payload);
        setShowOverwriteModal(true);
        return;
      }
      throw error;
    }
  };

  const handleConfirmOverwrite = async () => {
    if (!pendingPayload) return;
    const actor = auth.currentUser?.uid || "unknown";
    const productId = await createSupplierProduct(hotelUid, pendingPayload, actor, {
      overwriteExisting: true,
    });
    setShowOverwriteModal(false);
    setPendingPayload(null);
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
          <SupplierProductFormFields
            onSubmit={handleCreate}
            savingLabel={t("products.actions.saving")}
            submitLabel={t("products.actions.create")}
          />
        </Card>
      </PageContainer>

      <Modal
        open={showOverwriteModal}
        onClose={() => {
          setShowOverwriteModal(false);
          setPendingPayload(null);
        }}
        title="Supplier product bestaat al"
      >
        <p className="text-sm text-gray-700">
          Er bestaat al een supplier product met dezelfde combinatie van Supplier ID en Supplier SKU.
          Wil je dit bestaande product overschrijven?
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setShowOverwriteModal(false);
              setPendingPayload(null);
            }}
            className="px-4 py-2 rounded border border-gray-300 text-gray-700"
          >
            Annuleren
          </button>
          <button
            type="button"
            onClick={handleConfirmOverwrite}
            className="px-4 py-2 rounded bg-[#b41f1f] text-white hover:bg-[#961919]"
          >
            Overschrijven
          </button>
        </div>
      </Modal>
    </div>
  );
}
