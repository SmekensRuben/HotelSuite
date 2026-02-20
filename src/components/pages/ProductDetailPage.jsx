import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Pencil, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { deleteCatalogProduct, getCatalogProduct } from "../../services/firebaseProducts";
import { getUserDisplayName } from "../../services/firebaseUserManagement";
import { usePermission } from "../../hooks/usePermission";

function formatDate(value) {
  if (!value) return "-";
  if (typeof value?.toDate === "function") return value.toDate().toLocaleString();
  if (typeof value?.seconds === "number") return new Date(value.seconds * 1000).toLocaleString();
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
  const { t } = useTranslation("common");
  const { productId } = useParams();
  const { hotelUid } = useHotelContext();
  const canEditProducts = usePermission("products", "edit");
  const canDeleteProducts = usePermission("products", "delete");
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [createdByName, setCreatedByName] = useState("-");
  const [updatedByName, setUpdatedByName] = useState("-");
  const [showDeleteModal, setShowDeleteModal] = useState(false);

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

  useEffect(() => {
    const loadUserNames = async () => {
      if (!product) return;
      const [createdName, updatedName] = await Promise.all([
        getUserDisplayName(product.createdBy),
        getUserDisplayName(product.updatedBy),
      ]);
      setCreatedByName(createdName);
      setUpdatedByName(updatedName);
    };
    loadUserNames();
  }, [product]);

  const handleDeleteProduct = async () => {
    if (!hotelUid || !productId || !canDeleteProducts) return;
    await deleteCatalogProduct(hotelUid, productId);
    setShowDeleteModal(false);
    navigate("/catalog/products");
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-100 to-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">{t("products.catalog")}</p>
            <h1 className="text-3xl font-semibold">{t("products.detail.title")}</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/catalog/products/${productId}/edit`)}
              disabled={!canEditProducts}
              className={`inline-flex items-center justify-center rounded border p-2 ${
                canEditProducts
                  ? "border-gray-300 text-gray-700 hover:bg-gray-100"
                  : "border-gray-200 text-gray-400 cursor-not-allowed"
              }`}
              title={t("products.actions.edit")}
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteModal(true)}
              disabled={!canDeleteProducts}
              className={`inline-flex items-center justify-center rounded border p-2 ${
                canDeleteProducts
                  ? "border-red-200 text-red-700 hover:bg-red-50"
                  : "border-gray-200 text-gray-400 cursor-not-allowed"
              }`}
              title={t("products.actions.delete")}
            >
              <Trash2 className="h-4 w-4" />
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

        {loading ? (
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
                    <div className="h-56 flex items-center justify-center text-gray-400 text-sm">
                      {t("products.detail.noImage")}
                    </div>
                  )}
                </div>
                <div>
                  <h2 className="text-2xl font-semibold text-gray-900">{product.name || "-"}</h2>
                  <p className="text-gray-600 mt-1">{product.brand || "-"}</p>
                  <p className="mt-3 text-sm text-gray-700">{product.description || "-"}</p>
                  <div className="mt-4">
                    <span
                      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                        product.active !== false
                          ? "bg-green-100 text-green-700"
                          : "bg-gray-200 text-gray-700"
                      }`}
                    >
                      {product.active !== false ? t("products.status.active") : t("products.status.inactive")}
                    </span>
                  </div>
                </div>
              </div>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <h2 className="text-lg font-semibold mb-3">{t("products.sections.classification")}</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <DetailField label={t("products.fields.category")} value={product.category} />
                  <DetailField label={t("products.fields.subcategory")} value={product.subcategory} />
                </div>
              </Card>

              <Card>
                <h2 className="text-lg font-semibold mb-3">{t("products.sections.units")}</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <DetailField label={t("products.fields.baseUnit")} value={product.baseUnit} />
                  <DetailField
                    label={t("products.fields.baseQtyPerUnit")}
                    value={product.baseQtyPerUnit}
                  />
                </div>
              </Card>

              <Card>
                <h2 className="text-lg font-semibold mb-3">{t("products.sections.identifiers")}</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <DetailField label={t("products.fields.gtin")} value={product.gtin} />
                  <DetailField label={t("products.fields.internalSku")} value={product.internalSku} />
                </div>
              </Card>

              <Card>
                <h2 className="text-lg font-semibold mb-3">{t("products.sections.storage")}</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <DetailField label={t("products.fields.storageType")} value={product.storageType} />
                  <DetailField
                    label={t("products.fields.allergens")}
                    value={Array.isArray(product.allergens) ? product.allergens.join(", ") : ""}
                  />
                  <DetailField label={t("products.fields.notes")} value={product.notes} />
                </div>
              </Card>

              <Card className="lg:col-span-2">
                <h2 className="text-lg font-semibold mb-3">{t("products.sections.audit")}</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <DetailField label={t("products.fields.createdAt")} value={formatDate(product.createdAt)} />
                  <DetailField label={t("products.fields.createdBy")} value={createdByName} />
                  <DetailField label={t("products.fields.updatedAt")} value={formatDate(product.updatedAt)} />
                  <DetailField label={t("products.fields.updatedBy")} value={updatedByName} />
                </div>
              </Card>
            </div>
          </>
        )}
      </PageContainer>

      <Modal
        open={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        title={t("products.deleteModal.title")}
      >
        <p className="text-sm text-gray-700">{t("products.deleteModal.message")}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowDeleteModal(false)}
            className="px-4 py-2 rounded border border-gray-300 text-gray-700"
          >
            {t("products.actions.cancel")}
          </button>
          <button
            type="button"
            onClick={handleDeleteProduct}
            disabled={!canDeleteProducts}
            className={`px-4 py-2 rounded ${
              canDeleteProducts
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
          >
            {t("products.actions.delete")}
          </button>
        </div>
      </Modal>
    </div>
  );
}
