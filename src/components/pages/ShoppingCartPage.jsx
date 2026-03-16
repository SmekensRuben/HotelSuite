import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ShoppingCart, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createOrdersFromShoppingCart } from "../../services/firebaseOrders";
import { getOutlets } from "../../services/firebaseSettings";
import {
  getShoppingCart,
  removeShoppingCartItem,
  updateShoppingCartItemOutlet,
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
  const [outlets, setOutlets] = useState([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [showDeliveryAdjustmentsModal, setShowDeliveryAdjustmentsModal] = useState(false);
  const [deliveryAdjustments, setDeliveryAdjustments] = useState([]);

  const getTomorrowIsoDate = () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const year = tomorrow.getFullYear();
    const month = String(tomorrow.getMonth() + 1).padStart(2, "0");
    const day = String(tomorrow.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

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

  useEffect(() => {
    const loadOutlets = async () => {
      if (!hotelUid) return;
      const fetchedOutlets = await getOutlets(hotelUid);
      setOutlets(fetchedOutlets || []);
    };

    loadOutlets();
  }, [hotelUid]);

  const items = Array.isArray(shoppingCart?.items) ? shoppingCart.items : [];
  const cartTotal = items.reduce(
    (sum, item) => sum + Number(item.pricePerPurchaseUnit || 0) * Number(item.qtyPurchaseUnits || 0),
    0
  );
  const hasMissingOutlets = items.some((item) => !String(item.outletId || "").trim());

  const rows = items.map((item, index) => {
    const unitPrice = Number(item.pricePerPurchaseUnit || 0);
    const qty = Number(item.qtyPurchaseUnits || 0);
    return {
      id: `${item.supplierProductId || "row"}-${index}`,
      supplierId: item.supplierId || "-",
      supplierName: item.supplierName || item.supplierId || "-",
      supplierProductName: item.supplierProductName || "-",
      imageUrl: item.imageUrl || "",
      supplierSku: item.supplierSku || "-",
      purchaseUnit: item.purchaseUnit || "-",
      content: formatContent(item),
      unitPrice: `${unitPrice.toFixed(2)} ${item.currency || "EUR"}`,
      subtotal: `${(unitPrice * qty).toFixed(2)} ${item.currency || "EUR"}`,
      rowIndex: index,
      supplierProductId: item.supplierProductId,
      qtyPurchaseUnits: qty,
      outletId: item.outletId || "",
    };
  });

  const columns = [
    {
      key: "supplier",
      label: "Supplier",
      render: (row) => (
        <span className="inline-block max-w-[120px] truncate" title={row.supplierName}>
          {row.supplierName}
        </span>
      ),
      sortValue: (row) => String(row.supplierName || ""),
    },
    {
      key: "imageUrl",
      label: "Image",
      sortable: false,
      render: (row) => (
        row.imageUrl ? (
          <img
            src={row.imageUrl}
            alt={row.supplierProductName || "Supplier product"}
            className="h-14 w-14 rounded object-cover border border-gray-200"
          />
        ) : (
          <span className="text-xs text-gray-400">-</span>
        )
      ),
    },
    { key: "supplierProductName", label: "Product" },
    { key: "supplierSku", label: "SKU" },
    { key: "purchaseUnit", label: "Purchase Unit" },
    { key: "content", label: "Content" },
    {
      key: "outletId",
      label: "Outlet",
      sortable: false,
      render: (row) => (
        <select
          value={row.outletId}
          onChange={async (event) => {
            await updateShoppingCartItemOutlet(hotelUid, cartId, row.supplierProductId, event.target.value);
            await refreshCart();
          }}
          className="w-40 border border-gray-300 rounded px-2 py-1"
        >
          <option value="">Selecteer outlet</option>
          {outlets.map((outlet) => (
            <option key={outlet.id} value={outlet.id}>
              {outlet.name || outlet.id}
            </option>
          ))}
        </select>
      ),
    },
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
          className="w-16 border border-gray-300 rounded px-2 py-1"
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
          className="inline-flex items-center justify-center text-red-600 hover:text-red-800"
          title="Verwijderen"
          aria-label="Verwijderen"
        >
          <Trash2 className="h-4 w-4" />
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
              {hasMissingOutlets && (
                <p className="text-sm text-red-600">Selecteer een outlet voor elk supplierproduct om een order te kunnen maken.</p>
              )}
              {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}
              <button
                type="button"
                onClick={() => {
                  setErrorMessage("");
                  setDeliveryDate(getTomorrowIsoDate());
                  setShowCreateOrderModal(true);
                }}
                disabled={hasMissingOutlets}
                className="bg-blue-600 text-white px-4 py-2 rounded font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
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
            disabled={!deliveryDate || creatingOrder || hasMissingOutlets}
            onClick={async () => {
              if (!deliveryDate || hasMissingOutlets) return;
              setCreatingOrder(true);
              setErrorMessage("");
              try {
                const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
                const result = await createOrdersFromShoppingCart(hotelUid, cartId, deliveryDate, actor);
                const adjustments = Array.isArray(result?.deliveryDateAdjustments)
                  ? result.deliveryDateAdjustments
                  : [];

                setShowCreateOrderModal(false);

                if (adjustments.length > 0) {
                  setDeliveryAdjustments(adjustments);
                  setShowDeliveryAdjustmentsModal(true);
                } else {
                  navigate("/orders");
                }
              } catch (error) {
                setErrorMessage(error?.message || "Kon order niet aanmaken");
              } finally {
                setCreatingOrder(false);
              }
            }}
            className="px-4 py-2 rounded bg-[#b41f1f] text-white hover:bg-[#961919] disabled:opacity-50"
          >
            {creatingOrder ? "Creating..." : "Create"}
          </button>
        </div>
      </Modal>

      <Modal
        open={showDeliveryAdjustmentsModal}
        onClose={() => {
          setShowDeliveryAdjustmentsModal(false);
          navigate("/orders");
        }}
        title="Leverdagen automatisch aangepast"
      >
        <p className="text-sm text-gray-700">
          We hebben de leverdata automatisch afgestemd op de ingestelde leverdagen van je suppliers.
          Hieronder zie je per supplier welke datum werd aangepast.
        </p>

        <div className="mt-4 space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
          {deliveryAdjustments.map((adjustment) => (
            <div key={`${adjustment.supplierId}-${adjustment.resolvedDeliveryDate}`} className="text-sm text-gray-800">
              <span className="font-semibold">{adjustment.supplierName || adjustment.supplierId}</span>
              <span className="text-gray-600">: {adjustment.requestedDeliveryDate} → {adjustment.resolvedDeliveryDate}</span>
            </div>
          ))}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={() => {
              setShowDeliveryAdjustmentsModal(false);
              navigate("/orders");
            }}
            className="px-4 py-2 rounded bg-[#b41f1f] text-white hover:bg-[#961919]"
          >
            Verder naar Orders
          </button>
        </div>
      </Modal>
    </div>
  );
}
