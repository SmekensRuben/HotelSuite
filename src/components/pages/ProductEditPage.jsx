import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import ProductFormFields from "./ProductFormFields";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getCatalogProduct, updateCatalogProduct } from "../../services/firebaseProducts";

export default function ProductEditPage() {
  const navigate = useNavigate();
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
      const data = await getCatalogProduct(hotelUid, productId);
      setProduct(data);
      setLoading(false);
    };
    loadProduct();
  }, [hotelUid, productId]);

  const handleUpdate = async (payload) => {
    const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
    await updateCatalogProduct(hotelUid, productId, payload, actor);
    navigate(`/catalog/products/${productId}`);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Catalog</p>
          <h1 className="text-3xl font-semibold">Product bewerken</h1>
        </div>

        {loading ? (
          <p className="text-gray-600">Product laden...</p>
        ) : !product ? (
          <Card>
            <p className="text-gray-600">Product niet gevonden.</p>
          </Card>
        ) : (
          <Card>
            <ProductFormFields
              hotelUid={hotelUid}
              initialData={product}
              onSubmit={handleUpdate}
              savingLabel="Opslaan..."
              submitLabel="Wijzigingen opslaan"
            />
          </Card>
        )}
      </PageContainer>
    </div>
  );
}
