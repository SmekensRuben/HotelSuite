import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierProducts } from "../../services/firebaseProducts";
import { createShoppingCart } from "../../services/firebaseOrders";

const PAGE_SIZE = 200;

function resolveVariantOptions(product) {
  if (!product.hasVariants || !Array.isArray(product.variants) || product.variants.length === 0) {
    return [
      {
        id: "",
        label: "Standaard",
        pricePerPurchaseUnit: Number(product.pricePerPurchaseUnit) || 0,
        baseUnitsPerPurchaseUnit: Number(product.baseUnitsPerPurchaseUnit) || 0,
      },
    ];
  }

  return product.variants.map((variant, index) => ({
    id: String(index),
    label: `Variant ${index + 1}`,
    pricePerPurchaseUnit: Number(variant.pricePerPurchaseUnit) || 0,
    baseUnitsPerPurchaseUnit: Number(variant.baseUnitsPerPurchaseUnit) || 0,
  }));
}

export default function OrderCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
    const loadProducts = async () => {
      if (!hotelUid) return;
      setLoading(true);
      const result = await getSupplierProducts(hotelUid, { pageSize: PAGE_SIZE });
      setProducts(result.products || []);
      setLoading(false);
    };

    loadProducts();
  }, [hotelUid]);

  const updateCart = (productId, patch) => {
    setCart((prev) => ({
      ...prev,
      [productId]: {
        qtyPurchaseUnits: 0,
        variantId: "",
        ...prev[productId],
        ...patch,
      },
    }));
  };

  const handleSave = async () => {
    if (!hotelUid || saving) return;

    const items = products
      .map((product) => {
        const cartLine = cart[product.id] || {};
        const qtyPurchaseUnits = Number(cartLine.qtyPurchaseUnits) || 0;
        if (qtyPurchaseUnits <= 0) return null;

        const variants = resolveVariantOptions(product);
        const selectedVariant =
          variants.find((variant) => variant.id === String(cartLine.variantId || "")) || variants[0];

        return {
          supplierId: product.supplierId,
          supplierProductId: product.id,
          variantId: selectedVariant?.id || "",
          qtyPurchaseUnits,
          supplierSku: product.supplierSku,
          supplierProductName: product.supplierProductName,
          purchaseUnit: product.purchaseUnit,
          pricingModel: product.pricingModel,
          pricePerPurchaseUnit:
            Number(selectedVariant?.pricePerPurchaseUnit) || Number(product.pricePerPurchaseUnit) || 0,
          currency: product.currency || "EUR",
          baseUnit: product.baseUnit,
          baseUnitsPerPurchaseUnit:
            Number(selectedVariant?.baseUnitsPerPurchaseUnit) || Number(product.baseUnitsPerPurchaseUnit) || 0,
        };
      })
      .filter(Boolean);

    try {
      setSaving(true);
      const createdBy = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
      await createShoppingCart(hotelUid, { createdBy, items });
      navigate("/orders");
    } catch (error) {
      window.alert(error.message || "Kon shopping cart niet opslaan.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer>
        <Card>
          <div className="flex items-center justify-between gap-3 mb-4">
            <h1 className="text-2xl font-semibold">Nieuwe order</h1>
            <button
              onClick={() => navigate("/orders")}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm font-semibold"
            >
              Terug
            </button>
          </div>

          {loading ? (
            <p className="text-sm text-gray-600">Supplier products laden...</p>
          ) : (
            <div className="space-y-3">
              {products.map((product) => {
                const line = cart[product.id] || { qtyPurchaseUnits: 0, variantId: "" };
                const variants = resolveVariantOptions(product);

                return (
                  <div key={product.id} className="grid gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:grid-cols-12">
                    <div className="sm:col-span-5">
                      <p className="text-sm font-semibold text-gray-900">{product.supplierProductName || product.id}</p>
                      <p className="text-xs text-gray-500">{product.supplierSku} · {product.supplierId}</p>
                    </div>

                    <div className="sm:col-span-3">
                      <label className="text-xs text-gray-500">Variant</label>
                      <select
                        value={String(line.variantId || "")}
                        onChange={(event) => updateCart(product.id, { variantId: event.target.value })}
                        className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                      >
                        {variants.map((variant) => (
                          <option key={variant.id || "default"} value={variant.id}>
                            {variant.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="sm:col-span-2">
                      <label className="text-xs text-gray-500">Aantal</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={line.qtyPurchaseUnits}
                        onChange={(event) => updateCart(product.id, { qtyPurchaseUnits: event.target.value })}
                        className="mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm"
                      />
                    </div>

                    <div className="sm:col-span-2 flex items-end">
                      <div className="text-xs text-gray-600">
                        {product.currency || "EUR"} {Number(product.pricePerPurchaseUnit || 0).toFixed(2)}
                        <div>{product.purchaseUnit || "purchase unit"}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-6 flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving || loading}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {saving ? "Opslaan..." : "Shopping cart opslaan"}
            </button>
          </div>
        </Card>
      </PageContainer>
    </div>
  );
}
