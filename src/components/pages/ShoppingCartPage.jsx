import React, { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, MessageSquarePlus, ShoppingCart, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import DataListTable from "../shared/DataListTable";
import PendingCartCommand from "../catalog/PendingCartCommand";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createOrdersFromShoppingCart } from "../../services/firebaseOrders";
import { getOutlets } from "../../services/firebaseSettings";
import {
  getShoppingCart,
  removeShoppingCartItem,
  updateShoppingCartItemNote,
  updateShoppingCartItemOutlet,
  updateShoppingCartItemQty,
} from "../../services/firebaseShoppingCarts";

import { knownPrice } from "../../utils/productPurchaseOptions";

function formatContent(item) {
  const amount = Number(item?.baseUnitsPerPurchaseUnit || 0);
  const unit = String(item?.baseUnit || "").trim();
  if (!(amount > 0) || !unit) return "-";
  return `${amount} ${unit}`;
}

function ScopedShoppingCartPage() {
  const navigate = useNavigate();
  const { cartId } = useParams();
  const { hotelUid } = useHotelContext();
  const [shoppingCart, setShoppingCart] = useState(null);
  const mounted = useRef(true);
  const loadSequence = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; loadSequence.current += 1; }; }, []);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [showCreateOrderModal, setShowCreateOrderModal] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState("");
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [outlets, setOutlets] = useState([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [showDeliveryAdjustmentsModal, setShowDeliveryAdjustmentsModal] = useState(false);
  const [deliveryAdjustments, setDeliveryAdjustments] = useState([]);
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [activeNoteRow, setActiveNoteRow] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");

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
    const sequence = ++loadSequence.current;
    try {
      const cart = await getShoppingCart(hotelUid, cartId);
      if (mounted.current && sequence === loadSequence.current) setShoppingCart(cart);
    } catch (error) { if (mounted.current && sequence === loadSequence.current) setErrorMessage(error?.message || "Could not load the cart."); }
    finally { if (mounted.current && sequence === loadSequence.current) setLoading(false); }
  };

  useEffect(() => {
    refreshCart();
  }, [hotelUid, cartId]);

  useEffect(() => {
    const loadOutlets = async () => {
      if (!hotelUid) return;
      const fetchedOutlets = await getOutlets(hotelUid);
      if (mounted.current) setOutlets(fetchedOutlets || []);
    };

    loadOutlets().catch((error) => { if (mounted.current) setErrorMessage(error?.message || "Could not load hotel outlets."); });
  }, [hotelUid]);

  const performMutation = async (operation) => {
    if (mutating) return false;
    setMutating(true); setErrorMessage("");
    try { await operation(); await refreshCart(); return true; }
    catch (error) { if (mounted.current) setErrorMessage(error?.message || "Could not update this cart. Refresh stale data or retry the saved request."); return false; }
    finally { if (mounted.current) setMutating(false); }
  };

  const items = Array.isArray(shoppingCart?.items) ? shoppingCart.items : [];
  const cartTotals = items.reduce((totals, item) => {
    const price = knownPrice(item.pricePerPurchaseUnit);
    const currency = item.currency;
    if (price === null || !currency) return totals;
    const key = `${currency} (${item.priceBasis || "unknown"} price basis)`;
    totals[key] = (totals[key] || 0) + price * Number(item.qtyPurchaseUnits || 0);
    return totals;
  }, {});
  const hasUnknownPricing = items.some((item) => knownPrice(item.pricePerPurchaseUnit) === null || !item.currency);
  const hasMissingOutlets = items.some((item) => !String(item.outletId || "").trim());

  const rows = items.map((item, index) => {
    const unitPrice = knownPrice(item.pricePerPurchaseUnit);
    const qty = Number(item.qtyPurchaseUnits || 0);
    return {
      id: `${item.supplierProductId || "row"}:${item.purchaseOptionId || "default"}:${index}`,
      purchaseOptionId: item.purchaseOptionId || "default",
      supplierId: item.supplierId || "-",
      supplierName: item.supplierName || item.supplierId || "-",
      supplierProductName: item.supplierProductName || "-",
      imageUrl: item.imageUrl || "",
      supplierSku: item.supplierSku || "-",
      purchaseUnit: item.purchaseUnit || "-",
      content: formatContent(item),
      unitPrice: unitPrice === null ? "Price unavailable" : `${unitPrice.toFixed(2)} ${item.currency || "unknown currency"} (${item.priceBasis || "unknown"} basis)`,
      subtotal: unitPrice === null ? "Unavailable" : `${(unitPrice * qty).toFixed(2)} ${item.currency || "unknown currency"}`,
      rowIndex: index,
      supplierProductId: item.supplierProductId,
      qtyPurchaseUnits: qty,
      outletId: item.outletId || "",
      note: String(item.note || ""),
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
          <span className="text-xs text-gray-500">-</span>
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
          disabled={mutating}
          value={row.outletId}
          onChange={async (event) => {
            const value = event.target.value;
            await performMutation(() => updateShoppingCartItemOutlet(hotelUid, cartId, row.supplierProductId, value, row.purchaseOptionId, shoppingCart.revision ?? 0));
          }}
          className="w-40 border border-gray-300 rounded px-2 py-1"
        >
          <option value="">Select an outlet</option>
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
      label: "Quantity",
      sortable: false,
      render: (row) => (
        <input
          type="number"
          min="1"
          disabled={mutating}
          value={row.qtyPurchaseUnits}
          onChange={async (event) => {
            const value = event.target.value;
            await performMutation(() => updateShoppingCartItemQty(hotelUid, cartId, row.supplierProductId, value, row.purchaseOptionId, shoppingCart.revision ?? 0));
          }}
          className="w-16 border border-gray-300 rounded px-2 py-1"
        />
      ),
    },
    { key: "unitPrice", label: "Package price" },
    { key: "subtotal", label: "Total" },

    {
      key: "note",
      label: "Note",
      sortable: false,
      render: (row) => (
        <button
          type="button"
          onClick={() => {
            setActiveNoteRow(row);
            setNoteDraft(row.note || "");
            setShowNoteModal(true);
          }}
          className="inline-flex items-center justify-center rounded border border-gray-300 px-2 py-1 text-gray-700 hover:bg-gray-100"
          title={row.note ? "Edit note" : "Add note"}
          aria-label={row.note ? "Edit note" : "Add note"}
        >
          <MessageSquarePlus className="h-4 w-4" />
        </button>
      ),
    },
    {
      key: "actions",
      label: "Actions",
      sortable: false,
      render: (row) => (
        <button
          type="button"
          onClick={async () => {
            await performMutation(() => removeShoppingCartItem(hotelUid, cartId, row.supplierProductId, row.purchaseOptionId, shoppingCart.revision ?? 0));
          }}
          className="inline-flex items-center justify-center text-red-600 hover:text-red-800"
          disabled={mutating}
          title="Remove"
          aria-label="Remove"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <PendingCartCommand hotelUid={hotelUid} cartId={cartId} onComplete={async () => { setErrorMessage(""); await refreshCart(); }} />
        {errorMessage && <p role="alert" className="text-red-700">{errorMessage}</p>}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold">Shopping Cart</h1>
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <button type="button" disabled={loading || mutating} onClick={refreshCart} className="rounded border border-gray-300 px-3 py-2 text-sm font-semibold disabled:opacity-50">Refresh cart</button>
              <button
                type="button"
                onClick={() => navigate("/orders/new")}
                className="inline-flex items-center gap-2 border border-gray-300 rounded px-3 py-2 text-sm font-semibold hover:bg-gray-100"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>
              <span className="inline-flex items-center gap-2 bg-blue-100 text-blue-800 rounded px-3 py-2 text-sm font-semibold">
                <ShoppingCart className="w-4 h-4" />
                {items.length} items
              </span>
            </div>
          </div>
        </Card>

        {loading ? (
          <p className="text-sm text-gray-600">Loading shopping cart...</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-gray-600">The shopping cart is empty.</p>
        ) : (
          <>
            <DataListTable columns={columns} rows={rows} emptyMessage="The shopping cart is empty." />
            <div className="flex flex-col items-end gap-3">
              {Object.entries(cartTotals).map(([label, total]) => <p key={label} className="text-lg font-semibold">Quoted cart total: {total.toFixed(2)} {label}</p>)}
              {hasUnknownPricing && <p className="text-sm text-red-700">Some prices or currencies are unavailable. Review these offers before creating orders.</p>}
              {hasMissingOutlets && (
                <p className="text-sm text-red-600">Select an outlet for every package before creating orders.</p>
              )}
              {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}
              <button
                type="button"
                onClick={() => {
                  setErrorMessage("");
                  setDeliveryDate(getTomorrowIsoDate());
                  setShowCreateOrderModal(true);
                }}
                disabled={mutating || hasMissingOutlets || hasUnknownPricing}
                className="bg-brand-800 text-white px-4 py-2 rounded font-semibold hover:bg-brand-950 disabled:opacity-50"
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
            disabled={!deliveryDate || creatingOrder || mutating || hasMissingOutlets || hasUnknownPricing}
            onClick={async () => {
              if (!deliveryDate || hasMissingOutlets || hasUnknownPricing) return;
              setCreatingOrder(true);
              setErrorMessage("");
              try {
                const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
                const result = await createOrdersFromShoppingCart(hotelUid, cartId, deliveryDate, actor, shoppingCart?.revision || 0);
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
                setErrorMessage(error?.message || "Could not create orders");
              } finally {
                setCreatingOrder(false);
              }
            }}
            className="px-4 py-2 rounded bg-brand-800 text-white hover:bg-brand-950 disabled:opacity-50"
          >
            {creatingOrder ? "Creating..." : "Create"}
          </button>
        </div>
      </Modal>

      <Modal
        open={showNoteModal}
        onClose={() => {
          setShowNoteModal(false);
          setActiveNoteRow(null);
          setNoteDraft("");
        }}
        title={activeNoteRow?.note ? "Edit note" : "Add note"}
      >
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          Note
          <textarea
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
            rows={4}
            placeholder="Type your note..."
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setShowNoteModal(false);
              setActiveNoteRow(null);
              setNoteDraft("");
            }}
            className="px-4 py-2 rounded border border-gray-300 text-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!activeNoteRow) return;
              const success = await performMutation(() => updateShoppingCartItemNote(
                hotelUid,
                cartId,
                activeNoteRow.supplierProductId,
                noteDraft.trim(),
                activeNoteRow.purchaseOptionId,
                shoppingCart.revision ?? 0
              ));
              if (!success) return;
              setShowNoteModal(false);
              setActiveNoteRow(null);
              setNoteDraft("");
            }}
            className="px-4 py-2 rounded bg-brand-800 text-white hover:bg-brand-950"
          >
            Save
          </button>
        </div>
      </Modal>

      <Modal
        open={showDeliveryAdjustmentsModal}
        onClose={() => {
          setShowDeliveryAdjustmentsModal(false);
          navigate("/orders");
        }}
        title="Delivery dates adjusted"
      >
        <p className="text-sm text-gray-700">
          Delivery dates were adjusted to the suppliers’ configured delivery days.
          The changes are shown below for each supplier.
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
            className="px-4 py-2 rounded bg-brand-800 text-white hover:bg-brand-950"
          >
            Continue to orders
          </button>
        </div>
      </Modal>
    </div>
  );
}

export default function ShoppingCartPage() {
  const { hotelUid } = useHotelContext();
  const { cartId } = useParams();
  return <ScopedShoppingCartPage key={`${hotelUid}:${cartId}`} />;
}
