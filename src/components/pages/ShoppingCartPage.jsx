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
import { createOrdersFromShoppingCart, previewOrdersFromShoppingCart, getPendingCartSubmission, retryPendingCartSubmission } from "../../services/firebaseOrders";
import { getOutlets } from "../../services/firebaseSettings";
import {
  getShoppingCart,
  removeShoppingCartItem,
  splitShoppingCartItem,
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

function lineIdentity(row) {
  return { lineId: row.lineId, expectedLineRevision: row.lineRevision };
}

function readSavedSubmission(hotelUid, cartId) {
  try { return getPendingCartSubmission(hotelUid, cartId); }
  catch (error) { return { recoveryError: error?.message || "Saved order recovery is unavailable. Restore browser storage access and reload before changing this cart." }; }
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
  const [savedSubmission, setSavedSubmission] = useState(() => readSavedSubmission(hotelUid, cartId));
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
  const [splitRow, setSplitRow] = useState(null);
  const [splitQuantity, setSplitQuantity] = useState("");
  const [splitOutlet, setSplitOutlet] = useState(null);
  const [splitError, setSplitError] = useState("");

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
  const recoveringCreation = creationUncertain || Boolean(savedSubmission);
  const cartBlocked = createBlocked || creationUncertain || Boolean(savedSubmission);
  useEffect(() => {
    const update = () => { if (isCurrent()) setSavedSubmission(readSavedSubmission(hotelUid, cartId)); };
    window.addEventListener("cart-submission-changed", update);
    window.addEventListener("storage", update);
    return () => { window.removeEventListener("cart-submission-changed", update); window.removeEventListener("storage", update); };
  }, [hotelUid, cartId]);
  useEffect(() => {
    let canceled = false;
    if (creationUncertain || savedSubmission) return undefined;
    setPricePreview(null); setPricePreviewError("");
    if (!showCreateOrderModal || !deliveryDate || !shoppingCart || !isCurrent()) { setPricePreviewLoading(false); return undefined; }
    setPricePreviewLoading(true);
    previewOrdersFromShoppingCart(hotelUid, cartId, deliveryDate, shoppingCart.revision ?? 0)
      .then((result) => { if (!canceled && isCurrent()) setPricePreview(result); })
      .catch((error) => { if (!canceled && isCurrent()) setPricePreviewError(error?.message || "Could not verify applicable prices."); })
      .finally(() => { if (!canceled && isCurrent()) setPricePreviewLoading(false); });
    return () => { canceled = true; };
  }, [showCreateOrderModal, deliveryDate, shoppingCart, hotelUid, cartId, priceReviewAttempt, creationUncertain, savedSubmission]);
  const refreshCart = async ({ background = false, expectedOutlet = null } = {}) => {
    if (!hotelUid || !cartId || !isCurrent()) return false;
    if (!background) setLoading(true);
    const sequence = ++loadSequence.current;
    try {
      const cart = await getShoppingCart(hotelUid, cartId, { minimumRevision: minimumCartRevision.current });
      if (!cart || !Number.isSafeInteger(cart.revision ?? 0) || (cart.revision ?? 0) < minimumCartRevision.current) throw new Error("The cart has not caught up with the saved request. Refresh before continuing.");
      if (!isCurrent() || sequence !== loadSequence.current) return false;
      const selectedRow = expectedOutlet && cart.items?.find((item, index) => (item.lineId || `legacy-${index}`) === expectedOutlet.rowId);
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
        setCartNeedsRefresh(true);
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
  const submissionBlocked = recoveringCreation
    ? mutating || creatingOrder || pendingCommand || Boolean(savedSubmission?.recoveryError)
    : !deliveryDate || createBlocked || hasMissingOutlets || hasUnknownPricing || pricePreviewLoading || !pricePreview;

  const rows = items.map((item, index) => {
    const unitPrice = knownPrice(item.pricePerPurchaseUnit);
    const qty = Number(item.qtyPurchaseUnits || 0);
    return {
      id: item.lineId || `legacy-${index}`,
      lineId: item.lineId || `legacy-${index}`,
      lineRevision: item.lineRevision ?? 0,
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
      addedByName: item.addedByName || (item.addedBy ? "Team member" : "Not recorded"),
      updatedByName: item.updatedByName || (item.updatedBy ? "Team member" : "Not recorded"),
    };
  });
  const latestNoteRow = activeNoteRow && rows.find((row) => row.lineId === activeNoteRow.lineId);
  const noteChanged = activeNoteRow && (!latestNoteRow || latestNoteRow.lineRevision !== activeNoteRow.lineRevision);

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
    { key: "supplierProductName", label: "Product", render: (row) => <div><p>{row.supplierProductName}</p><p className="mt-1 text-xs text-slate-500">Added by {row.addedByName}<br />Last change by {row.updatedByName}</p></div> },
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
            await performMutation(() => updateShoppingCartItemOutlet(hotelUid, cartId, row.supplierProductId, outlet.id, row.purchaseOptionId, shoppingCart.revision ?? 0, lineIdentity(row)), { rowId: row.id, outlet });
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
        <CartQuantityInput key={`${hotelUid}:${cartId}:${row.id}`} quantity={row.qtyPurchaseUnits} purchaseUnit={row.purchaseUnit} revision={row.lineRevision} disabled={cartBlocked}
          onCommit={(value, expectedLineRevision) => performMutation(() => updateShoppingCartItemQty(hotelUid, cartId, row.supplierProductId, value, row.purchaseOptionId, shoppingCart.revision ?? 0, { lineId: row.lineId, expectedLineRevision }))} />
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
        <div className="flex items-center gap-3">
        <button type="button" disabled={cartBlocked || row.qtyPurchaseUnits <= 0.001} className="text-sm font-semibold text-brand-800 underline" onClick={() => { setSplitRow(row); setSplitQuantity(""); setSplitOutlet(null); setSplitError(""); }}>Split by outlet</button>
        <button
          type="button"
          onClick={async () => {
            await performMutation(() => removeShoppingCartItem(hotelUid, cartId, row.supplierProductId, row.purchaseOptionId, shoppingCart.revision ?? 0, lineIdentity(row)));
          }}
          className="inline-flex items-center justify-center text-red-600 hover:text-red-800"
          disabled={cartBlocked}
          title="Remove"
          aria-label="Remove"
        >
          <Trash2 className="h-4 w-4" />
        </button>
        </div>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage className="space-y-6">
        <PendingCartCommand hotelUid={hotelUid} cartId={cartId} inFlight={mutating || creatingOrder} onPendingChange={setPendingCommand} onComplete={async (result) => { if (!isCurrent()) return; minimumCartRevision.current = Math.max(minimumCartRevision.current, result.revision); setCartNeedsRefresh(true); if (!(await refreshCart({ background: true }))) throw new Error("The reconciled request needs a verified cart refresh before you can continue."); }} />
        {savedSubmission && !showCreateOrderModal && <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm"><p>{savedSubmission.recoveryError || "An order creation request is waiting for confirmation. Reconcile it before changing this shared cart."}</p><button type="button" disabled={creatingOrder || mutating || Boolean(savedSubmission.recoveryError)} className="mt-2 font-semibold underline" onClick={async () => {
          if (!isCurrent() || mutationLock.current) return;
          mutationLock.current = true; setCreatingOrder(true); setErrorMessage("");
          try { await retryPendingCartSubmission(hotelUid, cartId); if (isCurrent()) navigate("/orders"); }
          catch (error) { if (isCurrent()) setErrorMessage(error?.message || "Could not confirm the saved order creation request."); }
          finally { mutationLock.current = false; if (isCurrent()) { setCreatingOrder(false); setSavedSubmission(readSavedSubmission(hotelUid, cartId)); } }
        }}>{creatingOrder ? "Confirming saved request…" : "Retry saved order creation"}</button></div>}
        {errorMessage && !showNoteModal && !showCreateOrderModal && !splitRow && <p role="alert" className="text-red-700">{errorMessage}</p>}
        {cartNotice && <p role="status" className="text-sm text-amber-800">{cartNotice}</p>}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="text-xs uppercase tracking-wider text-slate-500">Purchasing & inventory</p><h1 className="text-2xl font-semibold">Shopping cart</h1><p className="mt-1 text-sm text-slate-600">This cart is shared by your hotel team. Each line belongs to one outlet. Use Split by outlet to divide a quantity.</p><p className="mt-1 text-xs text-slate-600">Changes save when confirmed. Refresh to see colleagues’ changes. The colleague creating orders reviews and submits every outlet in this cart.</p></div>
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

      <Modal open={showCreateOrderModal} onClose={() => { if (!recoveringCreation && !creatingOrder) setShowCreateOrderModal(false); }} title="Create Order">
        {errorMessage && <p role="alert" className="mb-3 text-sm text-red-700">{errorMessage}</p>}
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          Delivery Date
          <input
            type="date"
            disabled={creatingOrder || recoveringCreation}
            value={deliveryDate}
            onChange={(event) => { setPricePreview(null); setDeliveryDate(event.target.value); }}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        {recoveringCreation && <p role="alert" className="mt-3 text-sm text-amber-800">{savedSubmission?.recoveryError || "Creation could not be confirmed. Retry the saved request to reconcile its result before changing this cart or delivery date."}{savedSubmission?.deliveryDate && ` Saved delivery date: ${savedSubmission.deliveryDate}.`}</p>}
        <p className="mt-2 text-xs text-slate-600">Supplier delivery weekdays are applied before choosing prices. Future price lists are used only when applicable to the agreed date.</p>
        {!recoveringCreation && pricePreviewLoading && <p role="status" className="mt-3 text-sm text-slate-600">Reviewing applicable prices…</p>}
        {!recoveringCreation && pricePreviewError && <div className="mt-3 space-y-2"><p role="alert" className="text-sm text-red-700">{pricePreviewError}</p><button type="button" onClick={() => setPriceReviewAttempt((value) => value + 1)} className="rounded border px-3 py-2 text-sm">Review prices again</button></div>}
        {!recoveringCreation && pricePreview && <div className="mt-4 space-y-3" aria-label="Applicable order prices">{pricePreview.orders.map((order) => <section key={`${order.supplierId}:${order.outletId}`} className="rounded-lg border border-slate-200 p-3 text-sm">
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
            disabled={creatingOrder || recoveringCreation}
            className="px-4 py-2 rounded border border-gray-300 text-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submissionBlocked}
            onClick={async () => {
              if (submissionBlocked || mutationLock.current || !isCurrent()) return;
              mutationLock.current = true;
              setCreatingOrder(true);
              setErrorMessage("");
              try {
                const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
                const result = recoveringCreation
                  ? await retryPendingCartSubmission(hotelUid, cartId)
                  : await createOrdersFromShoppingCart(hotelUid, cartId, deliveryDate, actor, shoppingCart?.revision || 0, pricePreview.priceFingerprint);
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
                  if (error?.details?.orderRequestUncommitted === true) {
                    setCreationUncertain(false); setPricePreview(null); setPriceReviewAttempt((value) => value + 1);
                  } else setCreationUncertain(true);
                }
              } finally {
                mutationLock.current = false; if (isCurrent()) setCreatingOrder(false);
              }
            }}
            className="px-4 py-2 rounded bg-brand-800 text-white hover:bg-brand-950 disabled:opacity-50"
          >
            {creatingOrder ? "Creating..." : recoveringCreation ? "Retry saved creation" : "Create"}
          </button>
        </div>
      </Modal>

      <Modal
        open={showNoteModal}
        onClose={() => {
          if (mutating) return;
          setShowNoteModal(false);
          setActiveNoteRow(null);
          setNoteDraft("");
        }}
        title={activeNoteRow?.note ? "Edit note" : "Add note"}
      >
        {errorMessage && <p role="alert" className="mb-3 text-sm text-red-700">{errorMessage} Your note is still here.</p>}
        {cartNeedsRefresh && <button type="button" disabled={mutating || pendingCommand} onClick={() => refreshCart({ background: true })} className="mb-3 text-sm font-semibold underline">Refresh saved line</button>}
        {noteChanged && <div className="mb-3 rounded border border-amber-300 p-3 text-sm"><p>{latestNoteRow ? "This line changed while you were editing. Review the saved note before replacing it." : "This line was removed. Your note remains available to copy."}</p>{latestNoteRow && <><p className="mt-2 whitespace-pre-wrap">Saved note: {latestNoteRow.note || "No note"}</p><p className="mt-1">Outlet: {outlets.find((outlet) => outlet.id === latestNoteRow.outletId)?.name || "Unassigned"} · Quantity: {latestNoteRow.qtyPurchaseUnits}</p><button type="button" disabled={cartBlocked} onClick={() => setActiveNoteRow(latestNoteRow)} className="mt-2 font-semibold underline">I reviewed this line; keep my note</button></>}</div>}
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          Note
          <textarea
            disabled={mutating}
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
            disabled={mutating}
            className="px-4 py-2 rounded border border-gray-300 text-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={cartBlocked || noteChanged}
            onClick={async () => {
              if (!activeNoteRow) return;
              const success = await performMutation(() => updateShoppingCartItemNote(
                hotelUid,
                cartId,
                activeNoteRow.supplierProductId,
                noteDraft.trim(),
                activeNoteRow.purchaseOptionId,
                shoppingCart.revision ?? 0,
                lineIdentity(activeNoteRow)
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

      <Modal open={Boolean(splitRow)} onClose={() => { if (!mutating) setSplitRow(null); }} title="Split by outlet">
        <p className="text-sm text-slate-600">Move part of {splitRow?.supplierProductName} to another outlet. The original line keeps the remainder. Both lines keep the note; you can edit each note afterwards.</p>
        <label className="mt-4 flex flex-col gap-1 text-sm font-semibold">Quantity to move<input type="number" min="0.001" step="0.001" disabled={mutating} value={splitQuantity} onChange={(event) => setSplitQuantity(event.target.value)} className="ht-field" /></label>
        <p className="mt-1 text-xs text-slate-600">Current quantity: {splitRow?.qtyPurchaseUnits} {splitRow?.purchaseUnit}</p>
        <label className="mt-3 block text-sm font-semibold">Destination outlet</label>
        <Combobox aria-label="Destination outlet" options={outlets.filter((outlet) => outlet.id !== splitRow?.outletId)} value={splitOutlet} onChange={setSplitOutlet} disabled={mutating} displayValue={(outlet) => outlet.name || "Unnamed outlet"} getOptionValue={(outlet) => outlet.id} placeholder="Select an outlet" className="ht-field" />
        {(splitError || errorMessage) && <p role="alert" className="mt-3 text-sm text-red-700">{splitError || errorMessage}</p>}
        {cartNeedsRefresh && <p className="mt-2 text-sm text-amber-800">Close this dialog and refresh the cart before reviewing the split again.</p>}
        <div className="mt-4 flex justify-end gap-2"><button type="button" disabled={mutating} className="ht-button-secondary" onClick={() => setSplitRow(null)}>Cancel</button><button type="button" disabled={cartBlocked || !splitOutlet || !splitQuantity} className="ht-button-primary" onClick={async () => {
          const quantity = Number(splitQuantity);
          if (!splitRow || !Number.isFinite(quantity) || quantity <= 0 || quantity >= splitRow.qtyPurchaseUnits || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 1e-8) { setSplitError("Enter a positive quantity smaller than the current line, with up to three decimals."); return; }
          if (rows.some((row) => row.lineId !== splitRow.lineId && row.supplierProductId === splitRow.supplierProductId && row.purchaseOptionId === splitRow.purchaseOptionId && row.outletId === splitOutlet.id)) { setSplitError("This package already has a line for that outlet. Adjust the two existing quantities instead."); return; }
          setSplitError("");
          if (await performMutation(() => splitShoppingCartItem(hotelUid, cartId, splitRow, quantity, splitOutlet.id, shoppingCart.revision ?? 0))) setSplitRow(null);
        }}>Split quantity</button></div>
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
