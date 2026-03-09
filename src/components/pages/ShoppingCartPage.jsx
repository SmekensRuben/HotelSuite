import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ShoppingCart } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createOrdersFromShoppingCart } from "../../services/firebaseOrders";
import {
  getShoppingCart,
  removeShoppingCartItem,
  updateShoppingCartItemQty,
} from "../../services/firebaseShoppingCarts";

export default function ShoppingCartPage() {
  const navigate = useNavigate();
  const { cartId } = useParams();
  const { hotelUid } = useHotelContext();
  const [shoppingCart, setShoppingCart] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCreateOrderModal, setShowCreateOrderModal] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState("");
  const [creatingOrder, setCreatingOrder] = useState(false);

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

  const refreshCart = async () => {
    if (!hotelUid || !cartId) return;
    setLoading(true);
    const cart = await getShoppingCart(hotelUid, cartId);
    setShoppingCart(cart);
    setLoading(false);
  };

  useEffect(() => {
    refreshCart();
  }, [hotelUid, cartId]);

  const items = Array.isArray(shoppingCart?.items) ? shoppingCart.items : [];
  const cartTotal = items.reduce(
    (sum, item) => sum + Number(item.pricePerPurchaseUnit || 0) * Number(item.qtyPurchaseUnits || 0),
    0
  );

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer>
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold">Shopping Cart</h1>
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={() => navigate("/orders/new")}
                className="inline-flex items-center gap-2 border border-gray-300 rounded px-3 py-2 text-sm font-semibold hover:bg-gray-100"
              >
                <ArrowLeft className="w-4 h-4" />
                Terug
              </button>
              <span className="inline-flex items-center gap-2 bg-blue-100 text-blue-800 rounded px-3 py-2 text-sm font-semibold">
                <ShoppingCart className="w-4 h-4" />
                {items.length} items
              </span>
            </div>
          </div>

          {loading ? (
            <p className="mt-6 text-sm text-gray-600">Shopping cart laden...</p>
          ) : items.length === 0 ? (
            <p className="mt-6 text-sm text-gray-600">Er zitten nog geen producten in de shopping cart.</p>
          ) : (
            <>
              <div className="mt-6 overflow-x-auto">
                <table className="min-w-full border border-gray-200 rounded">
                  <thead className="bg-gray-100 text-xs uppercase text-gray-600">
                    <tr>
                      <th className="text-left px-4 py-2">Supplier</th>
                      <th className="text-left px-4 py-2">Product</th>
                      <th className="text-left px-4 py-2">SKU</th>
                      <th className="text-left px-4 py-2">Purchase Unit</th>
                      <th className="text-left px-4 py-2">Content</th>
                      <th className="text-left px-4 py-2">Aantal</th>
                      <th className="text-right px-4 py-2">Prijs / stuk</th>
                      <th className="text-right px-4 py-2">Totaal</th>
                      <th className="text-right px-4 py-2">Acties</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const unitPrice = Number(item.pricePerPurchaseUnit || 0);
                      const qty = Number(item.qtyPurchaseUnits || 0);
                      return (
                        <tr key={item.supplierProductId} className="border-t border-gray-200 text-sm">
                          <td className="px-4 py-2">{item.supplierId || "-"}</td>
                          <td className="px-4 py-2">{item.supplierProductName || "-"}</td>
                          <td className="px-4 py-2">{item.supplierSku || "-"}</td>
                          <td className="px-4 py-2">{item.purchaseUnit || "-"}</td>
                          <td className="px-4 py-2">{Number(item.baseUnitsPerPurchaseUnit || 0) > 0 && item.baseUnit ? `${Number(item.baseUnitsPerPurchaseUnit)} ${item.baseUnit}` : "-"}</td>
                          <td className="px-4 py-2">
                            <input
                              type="number"
                              min="1"
                              value={item.qtyPurchaseUnits}
                              onChange={async (event) => {
                                await updateShoppingCartItemQty(hotelUid, cartId, item.supplierProductId, event.target.value);
                                await refreshCart();
                              }}
                              className="w-24 border border-gray-300 rounded px-2 py-1"
                            />
                          </td>
                          <td className="px-4 py-2 text-right">{unitPrice.toFixed(2)} {item.currency || "EUR"}</td>
                          <td className="px-4 py-2 text-right">{(unitPrice * qty).toFixed(2)} {item.currency || "EUR"}</td>
                          <td className="px-4 py-2 text-right">
                            <button
                              type="button"
                              onClick={async () => {
                                await removeShoppingCartItem(hotelUid, cartId, item.supplierProductId);
                                await refreshCart();
                              }}
                              className="text-red-600 hover:text-red-800 font-semibold"
                            >
                              Verwijderen
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-5 flex flex-col items-end gap-3">
                <p className="text-lg font-semibold">Totaal shopping cart: {cartTotal.toFixed(2)} EUR</p>
                <button
                  type="button"
                  onClick={() => setShowCreateOrderModal(true)}
                  className="bg-blue-600 text-white px-4 py-2 rounded font-semibold hover:bg-blue-700"
                >
                  Create Order
                </button>
              </div>
            </>
          )}
        </Card>
      </PageContainer>

      <Modal open={showCreateOrderModal} onClose={() => setShowCreateOrderModal(false)} title="Create Order">
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          Delivery Date
          <input
            type="date"
            value={deliveryDate}
            onChange={(event) => setDeliveryDate(event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowCreateOrderModal(false)}
            className="px-4 py-2 rounded border border-gray-300 text-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!deliveryDate || creatingOrder}
            onClick={async () => {
              if (!deliveryDate) return;
              setCreatingOrder(true);
              const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
              await createOrdersFromShoppingCart(hotelUid, cartId, deliveryDate, actor);
              setCreatingOrder(false);
              setShowCreateOrderModal(false);
              navigate("/orders");
            }}
            className="px-4 py-2 rounded bg-[#b41f1f] text-white hover:bg-[#961919] disabled:opacity-50"
          >
            {creatingOrder ? "Creating..." : "Create"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
