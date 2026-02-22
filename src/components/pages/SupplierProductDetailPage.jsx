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
import { deleteSupplierProduct, getSupplierProduct } from "../../services/firebaseProducts";
import { getUserDisplayName } from "../../services/firebaseUserManagement";
import { usePermission } from "../../hooks/usePermission";

function formatDate(value) {
  if (!value) return "-";
  if (typeof value?.toDate === "function") return value.toDate().toLocaleString();
  if (typeof value?.seconds === "number") return new Date(value.seconds * 1000).toLocaleString();
  return String(value);
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "-";
  const num = Number(value);
  return Number.isNaN(num) ? String(value) : num;
}

function DetailField({ label, value }) {
  return (
    <div>
      <p className="text-xs tracking-wide text-gray-500">{label}</p>
      <p className="text-sm text-gray-800 mt-1">{value === null || value === undefined || value === "" ? "-" : String(value)}</p>
    </div>
  );
}

export default function SupplierProductDetailPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { productId } = useParams();
  const { hotelUid } = useHotelContext();
  const canEditProducts = usePermission("supplierproducts", "update");
  const canDeleteProducts = usePermission("supplierproducts", "delete");
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [createdByName, setCreatedByName] = useState("-");
  const [updatedByName, setUpdatedByName] = useState("-");

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
    await deleteSupplierProduct(hotelUid, productId);
    setShowDeleteModal(false);
    navigate("/catalog/supplier-products");
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-100 to-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">{t("products.catalog")}</p>
            <h1 className="text-3xl font-semibold">Supplier Product Detail</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/catalog/supplier-products/${productId}/edit`)}
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
          <Card>
            <div className="grid gap-4 sm:grid-cols-2">
              <DetailField label="Supplier ID" value={product.supplierId} />
              <DetailField label="Supplier SKU" value={product.supplierSku} />
              <DetailField label="Supplier Product Name" value={product.supplierProductName} />
              <DetailField label="Currency" value={product.currency || "EUR"} />
              <DetailField label="Pricing Model" value={product.pricingModel || "Per Purchase Unit"} />
              {product.pricingModel === "Per Base Unit" ? (
                <DetailField label="Price per Base Unit" value={product.pricePerBaseUnit} />
              ) : (
                <>
                  <DetailField label="Purchase Unit" value={product.purchaseUnit} />
                  <DetailField label="Price per Purchase Unit" value={product.pricePerPurchaseUnit} />
                </>
              )}
              <DetailField label="Base Unit" value={product.baseUnit} />
              {product.pricingModel === "Per Purchase Unit" && (
                <DetailField
                  label="Base Units per Purchase Unit"
                  value={product.baseUnitsPerPurchaseUnit}
                />
              )}
              {product.hasVariants && Array.isArray(product.variants) && product.variants.length > 0 && (
                <div className="sm:col-span-2 space-y-2">
                  <p className="text-xs tracking-wide text-gray-500">Variants</p>
                  {product.variants.map((variant, index) => (
                    <div key={index} className="grid gap-3 sm:grid-cols-2 border border-gray-200 rounded-lg p-3 bg-gray-50">
                      <DetailField label={`Variant ${index + 1} - Weight per Base Unit`} value={formatNumber(variant.perBaseUnit)} />
                      <DetailField label={`Variant ${index + 1} - Packages`} value={formatNumber(variant.packages)} />
                      <DetailField
                        label={`Variant ${index + 1} - Base Units per Purchase Unit`}
                        value={formatNumber(variant.baseUnitsPerPurchaseUnit)}
                      />
                      <DetailField
                        label={`Variant ${index + 1} - Price per Purchase Unit`}
                        value={formatNumber(variant.pricePerPurchaseUnit)}
                      />
                    </div>
                  ))}
                </div>
              )}
              <DetailField label="Catalog Product ID" value={product.catalogProductId} />
              <DetailField label="Active" value={product.active ? "true" : "false"} />
              <DetailField label="Has Variants" value={product.hasVariants ? "true" : "false"} />
              <DetailField label="Created At" value={formatDate(product.createdAt)} />
              <DetailField label="Created By" value={createdByName} />
              <DetailField label="Updated At" value={formatDate(product.updatedAt)} />
              <DetailField label="Updated By" value={updatedByName} />
              <DetailField label="Price Updated On" value={formatDate(product.priceUpdatedOn)} />
            </div>
          </Card>
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
