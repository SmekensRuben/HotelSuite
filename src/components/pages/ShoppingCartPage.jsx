import React, { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, MessageSquarePlus, ShoppingCart, Trash2 } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Combobox } from "../ui/combobox";
import { Card } from "../layout/Card";
import Modal from "../shared/Modal";
import DataListTable from "../shared/DataListTable";
import PendingCartCommand from "../catalog/PendingCartCommand";
import SupplierProductImage from "../catalog/SupplierProductImage";
import CartQuantityInput from "../catalog/CartQuantityInput";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { createOrdersFromShoppingCart, previewOrdersFromShoppingCart } from "../../services/firebaseOrders";
import { getOutlets } from "../../services/firebaseSettings";
import {
  getShoppingCart,
  removeShoppingCartItem,
  updateShoppingCartItemNote,
  updateShoppingCartItemOutlet,
  updateShoppingCartItemQty,
} from "../../services/firebaseShoppingCarts";

import { knownPrice } from "../../utils/productPurchaseOptions";
import { formatOrderMoney, formatOrderPriceBasis, normalizeOrderPriceBasis } from "../../utils/orderPricing";
import { orderPriceReliability, orderPriceSource, orderPriceEvidence } from "../../utils/orderPriceReliability";

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
  const actor = useRef(auth.currentUser).current;
  const mutationLock = useRef(false), minimumCartRevision = useRef(0);
  const loadSequence = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; loadSequence.current += 1; }; }, []);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [pendingCommand, setPendingCommand] = useState(false);
  const [cartNeedsRefresh, setCartNeedsRefresh] = useState(false);
  const [pendingOutlet, setPendingOutlet] = useState(null);
  const [cartNotice, setCartNotice] = useState("");
  const [showCreateOrderModal, setShowCreateOrderModal] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState("");
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [creationUncertain, setCreationUncertain] = useState(false);
  const [pricePreview, setPricePreview] = useState(null);
  const [pricePreviewLoading, setPricePreviewLoading] = useState(false);
  const [pricePreviewError, setPricePreviewError] = useState("");
  const [priceReviewAttempt, setPriceReviewAttempt] = useState(0);
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

  const isCurrent = () => mounted.current && auth.currentUser === actor;
  const createBlocked = mutating || creatingOrder || pendingCommand || cartNeedsRefresh;
  const cartBlocked = createBlocked || creationUncertain;
  useEffect(() => {
    let canceled = false;
    if (creationUncertain) return undefined;
    setPricePreview(null); setPricePreviewError("");
    if (!showCreateOrderModal || !deliveryDate || !shoppingCart || !isCurrent()) { setPricePreviewLoading(false); return undefined; }
    setPricePreviewLoading(true);
    previewOrdersFromShoppingCart(hotelUid, cartId, deliveryDate, shoppingCart.revision ?? 0)
      .then((result) => { if (!canceled && isCurrent()) setPricePreview(result); })
      .catch((error) => { if (!canceled && isCurrent()) setPricePreviewError(error?.message || "Could not verify applicable prices."); })
      .finally(() => { if (!canceled && isCurrent()) setPricePreviewLoading(false); });
    return () => { canceled = true; };
  }, [showCreateOrderModal, deliveryDate, shoppingCart, hotelUid, cartId, priceReviewAttempt, creationUncertain]);
  const refreshCart = async ({ background = false, expectedOutlet = null } = {}) => {
    if (!hotelUid || !cartId || !isCurrent()) return false;
    if (!background) setLoading(true);
    const sequence = ++loadSequence.current;
    try {
      const cart = await getShoppingCart(hotelUid, cartId, { minimumRevision: minimumCartRevision.current });
      if (!cart || !Number.isSafeInteger(cart.revision ?? 0) || (cart.revision ?? 0) < minimumCartRevision.current) throw new Error("The cart has not caught up with the saved request. Refresh before continuing.");
      if (!isCurrent() || sequence !== loadSequence.current) return false;
      const selectedRow = expectedOutlet && cart.items?.find((item) => item.supplierProductId === expectedOutlet.productId && (item.purchaseOptionId || "default") === expectedOutlet.purchaseOptionId);
      setCartNotice(expectedOutlet && selectedRow?.outletId !== expectedOutlet.outlet.id ? "The cart changed again before it refreshed. The current saved outlet is shown; review it before creating orders." : "");
      setShoppingCart(cart); setCartNeedsRefresh(false); setPendingOutlet(null); setErrorMessage("");
      return true;
    } catch (error) { if (isCurrent() && sequence === loadSequence.current) { setCartNeedsRefresh(true); setErrorMessage(error?.message || "Could not load the cart."); } return false; }
    finally { if (isCurrent() && sequence === loadSequence.current) setLoading(false); }
  };

  useEffect(() => {
    refreshCart();
  }, [hotelUid, cartId]);

  useEffect(() => {
    const loadOutlets = async () => {
      if (!hotelUid) return;
      const fetchedOutlets = await getOutlets(hotelUid);
      if (isCurrent()) setOutlets(fetchedOutlets || []);
    };

    loadOutlets().catch((error) => { if (isCurrent()) setErrorMessage(error?.message || "Could not load hotel outlets."); });
  }, [hotelUid]);

  const performMutation = async (operation, outletDraft = null) => {
    if (cartBlocked || mutationLock.current || !isCurrent()) return false;
    mutationLock.current = true;
    setMutating(true); setErrorMessage(""); setCartNotice("");
    if (outletDraft) setPendingOutlet({ ...outletDraft, phase: "saving" });
    try {
      const result = await operation();
      if (!isCurrent()) return false;
      setCartNeedsRefresh(true);
      if (!Number.isSafeInteger(result?.revision) || result.revision < 0) throw new Error("The saved cart revision could not be confirmed. Refresh before continuing.");
      minimumCartRevision.current = Math.max(minimumCartRevision.current, result.revision);
      if (outletDraft) setPendingOutlet({ ...outletDraft, phase: "refreshing" });
      const refreshed = await refreshCart({ background: true, expectedOutlet: outletDraft });
      if (!refreshed && isCurrent() && outletDraft) setPendingOutlet({ ...outletDraft, phase: "unverified" });
      return refreshed;
    }
    catch (error) {
      if (isCurrent()) {
        setErrorMessage(error?.message || "Could not update this cart. Refresh stale data or retry the saved request.");
        if (error?.details?.cartRequestUncommitted === true) setPendingOutlet(null);
        else { setCartNeedsRefresh(true); if (outletDraft) setPendingOutlet({ ...outletDraft, phase: "unverified" }); }
      }
      return false;
    }
    finally { mutationLock.current = false; if (isCurrent()) setMutating(false); }
  };

  const items = Array.isArray(shoppingCart?.items) ? shoppingCart.items : [];
  const cartTotals = items.reduce((totals, item) => {
    const price = knownPrice(item.pricePerPurchaseUnit);
    const currency = item.currency;
    const quantity = knownPrice(item.qtyPurchaseUnits);
    if (price === null || quantity === null || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return totals;
    const basis = normalizeOrderPriceBasis(item.priceBasis), key = `${currency}:${basis}`;
    totals[key] = { currency, basis, total: (totals[key]?.total || 0) + price * quantity };
    return totals;
  }, {});
  const hasUnknownPricing = items.some((item) => knownPrice(item.pricePerPurchaseUnit) === null || knownPrice(item.qtyPurchaseUnits) === null || typeof item.currency !== "string" || !/^[A-Z]{3}$/.test(item.currency));
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
      image: item.image, imageRevision: item.imageRevision,
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
      key: "image",
      label: "Image",
      sortable: false,
      render: (row) => <SupplierProductImage hotelUid={hotelUid} product={{ ...row, id: row.supplierProductId }} className="h-14 w-14" />,
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
        <div className="min-w-[12rem]">
          <Combobox aria-label={`Outlet for ${row.supplierProductName}`} options={outlets} value={pendingOutlet?.rowId === row.id ? pendingOutlet.outlet : outlets.find((outlet) => outlet.id === row.outletId) || null} onChange={async (outlet) => {
            if (!outlet) return;
            await performMutation(() => updateShoppingCartItemOutlet(hotelUid, cartId, row.supplierProductId, outlet.id, row.purchaseOptionId, shoppingCart.revision ?? 0), { rowId: row.id, productId: row.supplierProductId, purchaseOptionId: row.purchaseOptionId, outlet });
          }} displayValue={(outlet) => outlet.name || "Unnamed outlet"} getOptionValue={(outlet) => outlet.id} placeholder="Search outlets" disabled={cartBlocked} className="ht-field" />
          {pendingOutlet?.rowId === row.id && <p role="status" className="mt-1 text-xs text-slate-600">{pendingOutlet.phase === "saving" ? "Saving selected outlet…" : pendingOutlet.phase === "refreshing" ? "Awaiting updated cart…" : "Selection not confirmed. Refresh or reconcile the saved request."}</p>}
        </div>
      ),
    },
    {
      key: "qty",
      label: "Quantity",
      sortable: false,
      render: (row) => (
        <CartQuantityInput key={`${hotelUid}:${cartId}:${row.id}`} quantity={row.qtyPurchaseUnits} purchaseUnit={row.purchaseUnit} revision={shoppingCart.revision ?? 0} disabled={cartBlocked}
          onCommit={(value, expectedRevision) => performMutation(() => updateShoppingCartItemQty(hotelUid, cartId, row.supplierProductId, value, row.purchaseOptionId, expectedRevision))} />
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
          disabled={cartBlocked}
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
          disabled={cartBlocked}
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
      <ProcurementPage className="space-y-6">
        <PendingCartCommand hotelUid={hotelUid} cartId={cartId} inFlight={mutating || creatingOrder} onPendingChange={setPendingCommand} onComplete={async (result) => { if (!isCurrent()) return; minimumCartRevision.current = Math.max(minimumCartRevision.current, result.revision); setCartNeedsRefresh(true); if (!(await refreshCart({ background: true }))) throw new Error("The reconciled request needs a verified cart refresh before you can continue."); }} />
        {errorMessage && <p role="alert" className="text-red-700">{errorMessage}</p>}
        {cartNotice && <p role="status" className="text-sm text-amber-800">{cartNotice}</p>}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="text-xs uppercase tracking-wider text-slate-500">Purchasing & inventory</p><h1 className="text-2xl font-semibold">Shopping cart</h1><p className="mt-1 text-sm text-slate-600">Assign each package to an outlet and review quantities before creating draft orders.</p></div>
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <button type="button" disabled={loading || mutating || creatingOrder} onClick={() => refreshCart({ background: true })} className="rounded border border-gray-300 px-3 py-2 text-sm font-semibold disabled:opacity-50">Refresh cart</button>
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
            <section aria-labelledby="cart-summary-heading" className="ml-auto w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
              <div className="flex items-center justify-between gap-3"><h2 id="cart-summary-heading" className="font-semibold">Cart summary</h2><span className="text-xs text-slate-500">{items.length} {items.length === 1 ? "line" : "lines"}</span></div>
              <dl className="mt-3 divide-y divide-slate-100">{Object.entries(cartTotals).map(([key, entry]) => <div key={key} className="flex items-start justify-between gap-4 py-2"><dt className="min-w-0 text-xs text-slate-600"><span className="block font-medium text-slate-800">{entry.currency}</span>{formatOrderPriceBasis(entry.basis)}</dt><dd className="shrink-0 text-sm font-semibold tabular-nums">{entry.total.toFixed(2)}</dd></div>)}</dl>
              <p className="mt-2 text-xs leading-5 text-slate-500">Indicative cart prices. The next step verifies approved prices for each supplier's order-date or delivery-date agreement. Currencies and price bases stay separate.</p>
              <div className="mt-3 space-y-2 text-sm">
              {hasUnknownPricing && <p className="text-sm text-red-700">Some prices or currencies are unavailable. Review these offers before creating orders.</p>}
              {hasMissingOutlets && (
                <p className="text-sm text-red-600">Select an outlet for every package before creating orders.</p>
              )}
              {cartNeedsRefresh && <p role="status" className="text-amber-800">Refresh the cart to confirm its current contents before creating orders.</p>}
              </div>
              <button
                type="button"
                onClick={() => {
                  setErrorMessage("");
                  setDeliveryDate(getTomorrowIsoDate());
                  setShowCreateOrderModal(true);
                }}
                disabled={cartBlocked || hasMissingOutlets || hasUnknownPricing}
                className="mt-4 w-full bg-brand-800 text-white px-4 py-2 rounded text-sm font-semibold hover:bg-brand-950 disabled:opacity-50"
              >
                Create Order
              </button>
            </section>
          </>
        )}
      </ProcurementPage>

      <Modal open={showCreateOrderModal} onClose={() => { if (!creationUncertain && !creatingOrder) setShowCreateOrderModal(false); }} title="Create Order">
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          Delivery Date
          <input
            type="date"
            disabled={creatingOrder || creationUncertain}
            value={deliveryDate}
            onChange={(event) => { setPricePreview(null); setDeliveryDate(event.target.value); }}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        {creationUncertain && <p role="alert" className="mt-3 text-sm text-amber-800">Creation could not be confirmed. Retry the saved request to reconcile its result before changing this cart or delivery date.</p>}
        <p className="mt-2 text-xs text-slate-600">Supplier delivery weekdays are applied before choosing prices. Future price lists are used only when applicable to the agreed date.</p>
        {pricePreviewLoading && <p role="status" className="mt-3 text-sm text-slate-600">Reviewing applicable prices…</p>}
        {pricePreviewError && <div className="mt-3 space-y-2"><p role="alert" className="text-sm text-red-700">{pricePreviewError}</p><button type="button" onClick={() => setPriceReviewAttempt((value) => value + 1)} className="rounded border px-3 py-2 text-sm">Review prices again</button></div>}
        {pricePreview && <div className="mt-4 space-y-3" aria-label="Applicable order prices">{pricePreview.orders.map((order) => <section key={`${order.supplierId}:${order.outletId}`} className="rounded-lg border border-slate-200 p-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{order.supplierName} · {order.outletName}</h3><span>{formatOrderMoney(order.totalAmount, order.currency)}</span></div>
          <p className="mt-1 text-xs text-slate-600">Delivery: {order.deliveryDate} · {formatOrderPriceBasis(order.priceBasis)}</p>
          <ul className="mt-2 divide-y divide-slate-100">{order.products.map((line) => <li key={`${line.supplierProductId}:${line.purchaseOptionId}`} className="py-2">
            <div className="flex justify-between gap-2"><span>{line.supplierProductName} · {line.qtyPurchaseUnits} {line.purchaseUnit}</span><span className="shrink-0 tabular-nums">{formatOrderMoney(line.pricePerPurchaseUnit, line.currency)} each</span></div>
            <p className={`mt-1 text-xs ${line.priceValidity === "unknown" || line.priceNeedsReview ? "text-amber-800" : "text-slate-600"}`}>{orderPriceReliability(line)}</p>
            <p className="mt-1 break-words text-xs text-slate-500">{orderPriceSource(line)}</p>
            <p className="mt-1 text-xs text-slate-500">{orderPriceEvidence(line)}</p>
          </li>)}</ul>
        </section>)}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowCreateOrderModal(false)}
            disabled={creatingOrder || creationUncertain}
            className="px-4 py-2 rounded border border-gray-300 text-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!deliveryDate || createBlocked || hasMissingOutlets || hasUnknownPricing || pricePreviewLoading || !pricePreview}
            onClick={async () => {
              if (!deliveryDate || createBlocked || mutationLock.current || hasMissingOutlets || hasUnknownPricing || pricePreviewLoading || !pricePreview || !isCurrent()) return;
              mutationLock.current = true;
              setCreatingOrder(true);
              setErrorMessage("");
              try {
                const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
                const result = await createOrdersFromShoppingCart(hotelUid, cartId, deliveryDate, actor, shoppingCart?.revision || 0, pricePreview.priceFingerprint);
                if (!isCurrent()) return;
                setCreationUncertain(false);
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
                if (isCurrent()) {
                  setErrorMessage(error?.message || "Could not create orders");
                  const code = String(error?.code || "").replace(/^functions\//, "");
                  if (["aborted", "failed-precondition", "invalid-argument", "permission-denied", "unauthenticated", "not-found", "already-exists"].includes(code)) {
                    setCreationUncertain(false); setPricePreview(null); setPriceReviewAttempt((value) => value + 1);
                  } else setCreationUncertain(true);
                }
              } finally {
                mutationLock.current = false; if (isCurrent()) setCreatingOrder(false);
              }
            }}
            className="px-4 py-2 rounded bg-brand-800 text-white hover:bg-brand-950 disabled:opacity-50"
          >
            {creatingOrder ? "Creating..." : creationUncertain ? "Retry saved creation" : "Create"}
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
            disabled={cartBlocked}
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
  const context = useHotelContext();
  const { cartId } = useParams();
  const session = useRef({ actor: auth.currentUser, sequence: 0 });
  if (session.current.actor !== auth.currentUser) session.current = { actor: auth.currentUser, sequence: session.current.sequence + 1 };
  const access = JSON.stringify([context.permissions || [], context.subscriptionActive, context.subscription]);
  return <ScopedShoppingCartPage key={`${context.hotelUid}:${cartId}:${auth.currentUser?.uid || ""}:${session.current.sequence}:${access}`} />;
}
