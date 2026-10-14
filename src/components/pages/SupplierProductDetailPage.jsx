import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Pencil, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import PendingProductCommand from "../catalog/PendingProductCommand";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { deleteSupplierProduct, getSupplierProduct, getCatalogProduct } from "../../services/firebaseProducts";
import AsyncError from "../shared/AsyncError";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { useStaffDisplayNames } from "../../hooks/useStaffDisplayNames";
import { usePermission } from "../../hooks/usePermission";
import { packageConversionLabel, productUnitLabel } from "../../utils/productUnitDisplay";
import { SupplierPriceHistory } from "../catalog/SupplierPriceInsights";
import SupplierProductImage from "../catalog/SupplierProductImage";
import SupplierProductImageUpload from "../catalog/SupplierProductImageUpload";
import { useSupplierProductAuthority } from "../../hooks/useSupplierProductAuthority";
import { formatOrderPriceBasis } from "../../utils/orderPricing";
import { LoadingStatus } from "../ui/ResourceLoading";

function formatDate(value) {
  if (!value) return "-";
  if (typeof value?.toDate === "function") return value.toDate().toLocaleString();
  if (typeof value?.seconds === "number") return new Date(value.seconds * 1000).toLocaleString();
  return String(value);
}

function DetailField({ label, value }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white/80 p-3">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-sm text-gray-900 mt-1 font-medium">{value === null || value === undefined || value === "" ? "-" : String(value)}</p>
    </div>
  );
}

export default function SupplierProductDetailPage() {
  const { productId } = useParams();
  const { hotelUid } = useHotelContext();
  const authority = useSupplierProductAuthority();
  return <ScopedSupplierProductDetailPage key={`${authority}:${productId}`} hotelUid={hotelUid} productId={productId} />;
}

function ScopedSupplierProductDetailPage({ hotelUid, productId }) {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const mounted = useRef(false);
  const actorAtMount = useRef(auth.currentUser).current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && auth.currentUser === actorAtMount;
  const canEditProducts = usePermission("supplierproducts", "update");
  const canDeleteProducts = usePermission("supplierproducts", "delete");
  const canReadCatalog = usePermission("catalogproducts", "read");
  const scopeKey = `${hotelUid}:${productId}`;
  const load = useCallback(() => getSupplierProduct(hotelUid, productId), [hotelUid, productId]);
  const query = useScopedAsync({ scopeKey, enabled: Boolean(hotelUid && productId), load });
  const product = query.data;
  const loading = query.loading;
  const catalogId = product?.catalogProductId || "";
  const loadCatalog = useCallback(() => getCatalogProduct(hotelUid, catalogId), [hotelUid, catalogId]);
  const catalogQuery = useScopedAsync({ scopeKey: `${hotelUid}:${catalogId}:${canReadCatalog}`, enabled: Boolean(hotelUid && catalogId && canReadCatalog), load: loadCatalog });
  const catalogProduct = canReadCatalog ? catalogQuery.data : null;
  const { createdByName, updatedByName } = useStaffDisplayNames({ hotelUid, scopeKey, record: product });
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);

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


  const handleDeleteProduct = async () => {
    if (!current() || !hotelUid || !productId || !canDeleteProducts || deleting) return;
    setDeleting(true); setDeleteError(null);
    try {
      await deleteSupplierProduct(hotelUid, productId, product?.revision ?? 0);
      if (current()) { setShowDeleteModal(false); navigate("/catalog/supplier-products"); }
    } catch (error) { if (current()) setDeleteError(error); }
    finally { if (current()) setDeleting(false); }
  };

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage className="space-y-6">
        <PendingProductCommand hotelUid={hotelUid} collection="supplierproducts" productId={productId} onComplete={() => { if (current()) navigate("/catalog/supplier-products"); }} />
        <AsyncError error={query.error} onRetry={query.retry} label="Could not load product." />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">{t("products.catalog")}</p>
            <h1 className="text-3xl font-semibold">Supplier Product Detail</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/catalog/supplier-products/${productId}/edit`)}
              disabled={!canEditProducts}
              className={`inline-flex items-center justify-center rounded border p-2 ${
                canEditProducts
                  ? "border-gray-300 text-gray-700 hover:bg-gray-100"
                  : "border-gray-200 text-gray-500 cursor-not-allowed"
              }`}
              title={t("products.actions.edit")}
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteModal(true)}
              disabled={!canDeleteProducts || deleting}
              className={`inline-flex items-center justify-center rounded border p-2 ${
                canDeleteProducts
                  ? "border-red-200 text-red-700 hover:bg-red-50"
                  : "border-gray-200 text-gray-500 cursor-not-allowed"
              }`}
              title="Archive"
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
          <LoadingStatus>Preparing supplier product details…</LoadingStatus>
        ) : query.error ? null : !product ? (
          <Card>
            <p className="text-gray-600">{t("products.notFound")}</p>
          </Card>
        ) : (
          <>
            <Card className="overflow-hidden border-0 shadow-xl shadow-slate-200/70">
              <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-700 p-6 text-white">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-300">Supplier product</p>
                    <h2 className="text-3xl font-semibold mt-2">{product.supplierProductName || "-"}</h2>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <span className="inline-flex items-center rounded-full bg-white/10 px-3 py-1 text-xs font-semibold">SKU: {product.supplierSku || "-"}</span>
                      <span className="inline-flex items-center rounded-full bg-white/10 px-3 py-1 text-xs font-semibold">Supplier: {product.supplierName || "Supplier name unavailable"}</span>
                      <span
                        className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                          product.active !== false && product.archived !== true ? "bg-emerald-400/20 text-emerald-200" : "bg-white/10 text-slate-200"
                        }`}
                      >
                        {product.active !== false && product.archived !== true ? t("products.status.active") : t("products.status.inactive")}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-6 bg-white">
                <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_160px] items-start">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <DetailField label="Supplier SKU" value={product.supplierSku} />
                    <DetailField label="Supplier" value={product.supplierName || "Supplier name unavailable"} />
                    <DetailField label="Pricing Model" value={product.pricingModel || "Per Purchase Unit"} />
                    <DetailField label="Currency" value={product.currency || "Unknown"} />
                  <DetailField label="Price basis" value={formatOrderPriceBasis(product.priceBasis)} />
                  <DetailField label="VAT rate" value={product.vatRate == null ? "Unknown / not applicable" : `${product.vatRate * 100}%`} />
                  <DetailField label="Contract price valid from" value={product.priceValidFrom || "Unknown"} />
                  <DetailField label="Contract price valid until" value={product.priceValidUntil || "Unknown"} />
                  <DetailField label="Default package GTIN" value={product.gtin || "Not supplied"} />
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Image</p>
                    <SupplierProductImage hotelUid={hotelUid} product={product} variant="display" className="w-full max-w-[220px] aspect-[4/3] object-contain rounded-lg border border-gray-200 bg-white p-1 mx-auto" />
                  </div>
                </div>
              </div>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              {canEditProducts && product.archived !== true && <Card className="lg:col-span-2"><h2 className="text-lg font-semibold mb-3">Product image</h2><SupplierProductImageUpload hotelUid={hotelUid} product={product} onChanged={query.retry} /></Card>}
              <Card className="border-0 shadow-md shadow-slate-200/70">
                <h2 className="text-lg font-semibold mb-3">Pricing</h2>
                <p className="mb-3 text-xs text-slate-600">Recorded catalog prices are indicative. Order preview checks applicable approved prices for the supplier's agreed order date or delivery date.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <DetailField label="Currency" value={product.currency || "Unknown"} />
                  <DetailField label="Price basis" value={formatOrderPriceBasis(product.priceBasis)} />
                  <DetailField label="VAT rate" value={product.vatRate == null ? "Unknown / not applicable" : `${product.vatRate * 100}%`} />
                  <DetailField label="Pricing Model" value={product.pricingModel || "Per Purchase Unit"} />
                  <DetailField label="Supplier content unit" value={productUnitLabel(product.baseUnit)} />
                  {product.pricingModel === "Per Base Unit" ? (
                    <>
                      <DetailField label="Purchase Unit" value={product.purchaseUnit} />
                      <DetailField label="Price per Base Unit" value={product.pricePerBaseUnit == null ? "Unknown" : product.pricePerBaseUnit} />
                      <DetailField label={`Package content (${product.baseUnit || "unknown unit"})`} value={product.baseUnitsPerPurchaseUnit} />
                      <DetailField label="Price per Purchase Unit" value={product.pricePerPurchaseUnit == null ? "Unknown" : product.pricePerPurchaseUnit} />
                    </>
                  ) : (
                    <>
                      <DetailField label="Purchase Unit" value={product.purchaseUnit} />
                      <DetailField label="Price per Purchase Unit" value={product.pricePerPurchaseUnit == null ? "Unknown" : product.pricePerPurchaseUnit} />
                      <DetailField label={`Package content (${product.baseUnit || "unknown unit"})`} value={product.baseUnitsPerPurchaseUnit} />
                    </>
                  )}
                </div>
              </Card>

              <Card className="border-0 shadow-md shadow-slate-200/70">
                <h2 className="text-lg font-semibold mb-3">Catalog link & stock units</h2>
                <AsyncError error={catalogQuery.error} onRetry={catalogQuery.retry} label="Could not load the linked catalog product." />
                <div className="grid gap-4 sm:grid-cols-2">
                  <DetailField label="Catalog product" value={catalogProduct?.name || (!catalogId ? "Unlinked — procurement only" : catalogQuery.loading ? "Loading catalog details…" : !canReadCatalog ? "Catalog read permission required" : "Catalog details unavailable")} />
                  <DetailField label="Stock-count unit" value={catalogProduct ? productUnitLabel(catalogProduct.baseUnit) : "Unavailable"} />
                  <DetailField label="Physical inventory tracking" value={!catalogProduct ? "Unavailable" : catalogProduct.inventoryTracked === true ? "Tracked" : catalogProduct.inventoryTracked === false ? "Not tracked" : "Needs review"} />
                </div>
                {catalogProduct && <p className="mt-4 rounded-lg bg-brand-50 p-3 text-sm text-gray-800">{packageConversionLabel(product.baseUnitsPerPurchaseUnit, product.baseUnit, catalogProduct.baseUnit)}</p>}
                {catalogProduct && catalogProduct.inventoryTracked !== true && <p className="mt-3 text-sm text-amber-800">{catalogProduct.inventoryTracked === false ? "Catalog inventory tracking is disabled." : "Catalog inventory tracking needs review."} This unit preview does not make receipts available to stock-count reports.</p>}
                {catalogProduct && (catalogProduct.active === false || catalogProduct.archived === true) && <p className="mt-3 text-sm text-amber-800">The linked catalog product is inactive for new purchasing. Existing orders keep their reviewed units.</p>}
                <p className="mt-3 text-sm text-gray-600">The supplier content unit describes this package. Physical counts use the linked catalog unit; compatible ml/l and g/kg quantities are converted when receiving goods.</p>
              </Card>

              {product.hasVariants && !product.purchaseOptions?.length && <Card className="lg:col-span-2"><p className="text-amber-800">Legacy variants require review in Edit before this offer can be ordered.</p></Card>}
              {product.purchaseOptions?.length > 0 && <Card className="lg:col-span-2"><h2 className="font-semibold mb-3">Additional purchase options</h2><p className="mb-3 text-xs text-slate-600">Package prices are indicative; the order preview selects the approved version for the agreed date.</p><div className="grid gap-3 md:grid-cols-2">{product.purchaseOptions.map((option) => <div key={option.id} className="space-y-3 rounded border p-3"><DetailField label="Package" value={option.purchaseUnit} /><DetailField label="Package GTIN" value={option.gtin || "Not supplied"} /><DetailField label={`Content (${product.baseUnit})`} value={option.baseUnitsPerPurchaseUnit} /><DetailField label={`Price (${product.currency || "unknown currency"})`} value={option.pricePerPurchaseUnit == null ? "Unknown" : option.pricePerPurchaseUnit} />{catalogProduct && <p className="text-sm text-gray-600">{packageConversionLabel(option.baseUnitsPerPurchaseUnit, product.baseUnit, catalogProduct.baseUnit)}</p>}</div>)}</div></Card>}

              <Card className="lg:col-span-2 border-0 shadow-md shadow-slate-200/70">
                <h2 className="text-lg font-semibold mb-3">Audit</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <DetailField label="Created At" value={formatDate(product.createdAt)} />
                  <DetailField label="Created By" value={createdByName} />
                  <DetailField label="Updated At" value={formatDate(product.updatedAt)} />
                  <DetailField label="Updated By" value={updatedByName} />
                  <DetailField label="Price Updated On" value={formatDate(product.priceUpdatedOn)} />
                </div>
              </Card>
            </div>
            <SupplierPriceHistory hotelUid={hotelUid} supplierProductId={productId} />
          </>
        )}
      </ProcurementPage>

      <Modal
        open={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        title={"Archive product"}
      >
        <p className="text-sm text-gray-700">Archive this product? Its stable identity and historical order/count references are preserved.</p>
        <AsyncError error={deleteError} onRetry={handleDeleteProduct} label="Could not archive this product." />
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
            disabled={!canDeleteProducts || deleting}
            className={`px-4 py-2 rounded ${
              canDeleteProducts
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
          >
            Archive
          </button>
        </div>
      </Modal>
    </div>
  );
}
