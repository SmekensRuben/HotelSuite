import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Pencil, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { deleteCatalogProduct, getCatalogProduct } from "../../services/firebaseProducts";
import { getUserDisplayName } from "../../services/firebaseUserManagement";

function formatDate(value) {
  if (!value) return "-";
  if (typeof value?.toDate === "function") {
    return value.toDate().toLocaleString();
  }
  if (typeof value?.seconds === "number") {
    return new Date(value.seconds * 1000).toLocaleString();
  }
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
  const { productId } = useParams();
  const { hotelUid } = useHotelContext();
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
    if (!hotelUid || !productId) return;
    await deleteCatalogProduct(hotelUid, productId);
    setShowDeleteModal(false);
    navigate("/catalog/products");
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
            <h1 className="text-3xl font-semibold">Product detail</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/catalog/products/${productId}/edit`)}
              className="inline-flex items-center justify-center rounded border border-gray-300 p-2 text-gray-700 hover:bg-gray-100"
              title="Bewerk product"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteModal(true)}
              className="inline-flex items-center justify-center rounded border border-red-200 p-2 text-red-700 hover:bg-red-50"
              title="Verwijder product"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => navigate("/catalog/products")}
              className="px-4 py-2 rounded border border-gray-300 font-semibold text-gray-700"
            >
              Terug naar Products
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-600">Product laden...</p>
        ) : !product ? (
          <Card>
            <p className="text-gray-600">Product niet gevonden.</p>
          </Card>
        ) : (
          <div className="space-y-4">
            <Card>
              <h2 className="text-lg font-semibold mb-3">Identity</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <DetailField label="Name" value={product.name} />
                <DetailField label="Brand" value={product.brand} />
                <DetailField label="Description" value={product.description} />
                <DetailField label="Active" value={product.active !== false ? "Ja" : "Nee"} />
                <div className="sm:col-span-2 lg:col-span-1">
                  <p className="text-xs uppercase tracking-wide text-gray-500">Image</p>
                  {product.imageUrl ? (
                    <img
                      src={product.imageUrl}
                      alt={product.name || "Product"}
                      className="mt-1 h-28 w-28 rounded object-cover border border-gray-200"
                    />
                  ) : (
                    <p className="text-sm text-gray-800 mt-1">-</p>
                  )}
                </div>
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Classification</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="Category" value={product.category} />
                <DetailField label="Subcategory" value={product.subcategory} />
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Units & Normalisation</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="Base Unit" value={product.baseUnit} />
                <DetailField label="Base Qty Per Unit" value={product.baseQtyPerUnit} />
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Identifiers</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="GTIN" value={product.gtin} />
                <DetailField label="Internal SKU" value={product.internalSku} />
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Storage & Operationally</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="Storage Type" value={product.storageType} />
                <DetailField
                  label="Allergens"
                  value={Array.isArray(product.allergens) ? product.allergens.join(", ") : ""}
                />
                <DetailField label="Notes" value={product.notes} />
              </div>
            </Card>

            <Card>
              <h2 className="text-lg font-semibold mb-3">Audit / Metadata</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="Created At" value={formatDate(product.createdAt)} />
                <DetailField label="Created By" value={createdByName} />
                <DetailField label="Updated At" value={formatDate(product.updatedAt)} />
                <DetailField label="Updated By" value={updatedByName} />
              </div>
            </Card>
          </div>
        )}
      </PageContainer>

      <Modal
        open={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        title="Product verwijderen"
      >
        <p className="text-sm text-gray-700">
          Ben je zeker dat je dit product wil verwijderen? Deze actie kan niet ongedaan gemaakt worden.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowDeleteModal(false)}
            className="px-4 py-2 rounded border border-gray-300 text-gray-700"
          >
            Annuleren
          </button>
          <button
            type="button"
            onClick={handleDeleteProduct}
            className="px-4 py-2 rounded bg-red-600 text-white hover:bg-red-700"
          >
            Verwijderen
          </button>
        </div>
      </Modal>
    </div>
  );
}
