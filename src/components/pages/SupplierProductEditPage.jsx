import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import ProductFormFields from "./ProductFormFields";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierProduct, updateSupplierProduct, uploadSupplierProductImage } from "../../services/firebaseProducts";

export default function SupplierProductEditPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { productId } = useParams();
  const { hotelUid } = useHotelContext();
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);

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
    const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
    await updateSupplierProduct(hotelUid, productId, payload, actor);
    navigate(`/catalog/supplier-products/${productId}`);
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
                </div>
              </div>
            </Card>

            <Card>
              <ProductFormFields
                hotelUid={hotelUid}
                initialData={product}
                onSubmit={handleUpdate}
                savingLabel={t("products.actions.saving")}
                submitLabel={t("products.actions.saveChanges")}
                uploadImage={uploadSupplierProductImage}
                showImagePreview={false}
              />
            </Card>
          </>
        )}
      </PageContainer>
    </div>
  );
}
