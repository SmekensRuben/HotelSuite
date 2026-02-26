import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import SupplierProductFormFields from "./SupplierProductFormFields";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierProduct, updateSupplierProduct } from "../../services/firebaseProducts";

export default function SupplierProductEditPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { productId } = useParams();
  const { hotelUid } = useHotelContext();
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    const loadProduct = async () => {
      if (!hotelUid || !productId) return;
      setLoading(true);
      const data = await getSupplierProduct(hotelUid, productId);
      setProduct(data);
      setLoading(false);
    };
    loadProduct();
  }, [hotelUid, productId]);

  const handleUpdate = async (payload) => {
    const actor = auth.currentUser?.uid || "unknown";
    try {
      const updatedProductId = await updateSupplierProduct(hotelUid, productId, payload, actor);
      navigate(`/catalog/supplier-products/${updatedProductId}`);
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
    const updatedProductId = await updateSupplierProduct(hotelUid, productId, pendingPayload, actor, {
      overwriteExisting: true,
    });
    setShowOverwriteModal(false);
    setPendingPayload(null);
    navigate(`/catalog/supplier-products/${updatedProductId}`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-100 to-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">{t("products.catalog")}</p>
            <h1 className="text-3xl font-semibold">Edit Supplier Product</h1>
          </div>
          <div className="flex items-center gap-2">
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

        {loading ? (
          <p className="text-gray-600">{t("products.loading")}</p>
        ) : !product ? (
          <Card>
            <p className="text-gray-600">{t("products.notFound")}</p>
          </Card>
        ) : (
          <>
            <Card>
              <SupplierProductFormFields
                initialData={product}
                onSubmit={handleUpdate}
                savingLabel={t("products.actions.saving")}
                submitLabel={t("products.actions.saveChanges")}
              />
            </Card>
          </>
        )}
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
