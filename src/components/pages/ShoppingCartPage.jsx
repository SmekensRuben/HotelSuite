import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ShoppingCart } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createOrdersFromShoppingCart } from "../../services/firebaseOrders";
import {
  getShoppingCart,
  removeShoppingCartItem,
  updateShoppingCartItemQty,
} from "../../services/firebaseShoppingCarts";

function formatContent(item) {
  const amount = Number(item?.baseUnitsPerPurchaseUnit || 0);
  const unit = String(item?.baseUnit || "").trim();
  if (!(amount > 0) || !unit) return "-";
  return `${amount} ${unit}`;
}

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

  const rows = items.map((item, index) => {
    const unitPrice = Number(item.pricePerPurchaseUnit || 0);
    const qty = Number(item.qtyPurchaseUnits || 0);
    return {
      id: `${item.supplierProductId || "row"}-${index}`,
      supplierId: item.supplierId || "-",
      supplierProductName: item.supplierProductName || "-",
      supplierSku: item.supplierSku || "-",
      purchaseUnit: item.purchaseUnit || "-",
      content: formatContent(item),
      unitPrice: `${unitPrice.toFixed(2)} ${item.currency || "EUR"}`,
      subtotal: `${(unitPrice * qty).toFixed(2)} ${item.currency || "EUR"}`,
      rowIndex: index,
      supplierProductId: item.supplierProductId,
      qtyPurchaseUnits: qty,
    };
  });

  const columns = [
    { key: "supplierId", label: "Supplier" },
    { key: "supplierProductName", label: "Product" },
    { key: "supplierSku", label: "SKU" },
    { key: "purchaseUnit", label: "Purchase Unit" },
    { key: "content", label: "Content" },
    {
      key: "qty",
      label: "Aantal",
      sortable: false,
      render: (row) => (
        <input
          type="number"
          min="1"
          value={row.qtyPurchaseUnits}
          onChange={async (event) => {
            await updateShoppingCartItemQty(hotelUid, cartId, row.supplierProductId, event.target.value);
            await refreshCart();
          }}
          className="w-24 border border-gray-300 rounded px-2 py-1"
        />
      ),
    },
    { key: "unitPrice", label: "Prijs / stuk" },
    { key: "subtotal", label: "Totaal" },
    {
      key: "actions",
      label: "Acties",
      sortable: false,
      render: (row) => (
        <button
          type="button"
          onClick={async () => {
            await removeShoppingCartItem(hotelUid, cartId, row.supplierProductId);
            await refreshCart();
          }}
          className="text-red-600 hover:text-red-800 font-semibold"
        >
          Verwijderen
        </button>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
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
        </Card>

        {loading ? (
          <p className="text-sm text-gray-600">Shopping cart laden...</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-gray-600">Er zitten nog geen producten in de shopping cart.</p>
        ) : (
          <>
            <DataListTable columns={columns} rows={rows} emptyMessage="Er zitten geen producten in de shopping cart." />
            <div className="flex flex-col items-end gap-3">
              <p className="text-lg font-semibold">Totaal shopping cart: {cartTotal.toFixed(2)} EUR</p>
              <button type="button" onClick={() => setShowCreateOrderModal(true)} className="bg-blue-600 text-white px-4 py-2 rounded font-semibold hover:bg-blue-700">
                Create Order
              </button>
            </div>
          </>
        )}
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
