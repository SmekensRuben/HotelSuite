import React, { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ShoppingCart } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { Combobox } from "../ui/combobox";
import PendingCartCommand from "../catalog/PendingCartCommand";
import SupplierProductImage from "../catalog/SupplierProductImage";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierProducts } from "../../services/firebaseProducts";
import { getSuppliers } from "../../services/firebaseSuppliers";
import { getOutlets } from "../../services/firebaseSettings";
import {
  addSupplierProductToShoppingCart,
  getOrCreateShoppingCart,
  getShoppingCart,
} from "../../services/firebaseShoppingCarts";

import { productPurchaseOptions, formatPurchasePrice, hasApprovedScheduledPrice, canAddPurchaseOptionToDraftCart } from "../../utils/productPurchaseOptions";

const PAGE_SIZE = 20;

function formatContent(product) {
  const amount = Number(product.baseUnitsPerPurchaseUnit || 0);
  const unit = String(product.baseUnit || "").trim();
  if (!(amount > 0) || !unit) return "-";
  return `${amount} ${unit}`;
}

function ScopedOrderCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [shoppingCart, setShoppingCart] = useState(null);
  const [products, setProducts] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [outlets, setOutlets] = useState([]);
  const [selectedOutlet, setSelectedOutlet] = useState(null);
  const [outletError, setOutletError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState("");
  const [preparingCart, setPreparingCart] = useState(true);
  const [cartNeedsRefresh, setCartNeedsRefresh] = useState(false);
  const [pendingCommand, setPendingCommand] = useState(false);
  const [supplierError, setSupplierError] = useState("");
  const [error, setError] = useState("");
  const [selectedOptions, setSelectedOptions] = useState({});
  const mounted = useRef(true);
  const actor = useRef(auth.currentUser).current;
  const cartLock = useRef(false);
  const minimumCartRevision = useRef(0);
  const generation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; }; }, []);
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMorePages, setHasMorePages] = useState(false);
  const [pageStartCursors, setPageStartCursors] = useState({ 0: null });
  const [qtyByProductId, setQtyByProductId] = useState({});

  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    []
  );

  const cartCount = Array.isArray(shoppingCart?.items) ? shoppingCart.items.length : 0;
  const isCurrent = () => mounted.current && auth.currentUser === actor;
  const cartBlocked = !shoppingCart?.id || preparingCart || cartNeedsRefresh || pendingCommand || Boolean(savingId);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebouncedSearchTerm(searchTerm), 300);
    return () => clearTimeout(timeoutId);
  }, [searchTerm]);

  const loadProductsPage = async (nextPageIndex, cursor) => {
    if (!hotelUid) return;

    setLoading(true); setError("");
    const currentGeneration = ++generation.current;
    try {
    const normalizedStatus = selectedStatus.trim().toLowerCase();
    const activeFilter =
      normalizedStatus === "active" ? true : normalizedStatus === "inactive" ? false : null;

    const result = await getSupplierProducts(hotelUid, {
      pageSize: PAGE_SIZE,
      cursor,
      searchTerm: debouncedSearchTerm,
      supplierId: selectedSupplierId,
      active: activeFilter,
    });

    if (!isCurrent() || currentGeneration !== generation.current) return;
    setProducts(result.products || []);
    setHasMorePages(result.hasMore);
    setPageIndex(nextPageIndex);

    if (result.hasMore && result.cursor) {
      setPageStartCursors((prev) => ({ ...prev, [nextPageIndex + 1]: result.cursor }));
    }

    setQtyByProductId((prev) => {
      const next = { ...prev };
      (result.products || []).forEach((product) => {
        if (!next[product.id]) next[product.id] = 1;
      });
      return next;
    });

    } catch (failure) { if (isCurrent() && currentGeneration === generation.current) setError(failure?.message || "Could not load supplier products."); }
    finally { if (isCurrent() && currentGeneration === generation.current) setLoading(false); }
  };

  const prepareCart = async () => {
    if (!hotelUid || cartLock.current || !isCurrent()) return;
    cartLock.current = true; setPreparingCart(true); setError("");
    try {
      const cart = shoppingCart?.id ? await getShoppingCart(hotelUid, shoppingCart.id, { minimumRevision: minimumCartRevision.current }) : await getOrCreateShoppingCart(hotelUid);
      if (!cart) throw new Error("The shopping cart could not be found. Reload this page before continuing.");
      if (isCurrent()) { setShoppingCart(cart); setCartNeedsRefresh(false); }
    } catch (failure) { if (isCurrent()) setError(failure?.message || "Could not prepare the cart."); }
    finally { cartLock.current = false; if (isCurrent()) setPreparingCart(false); }
  };

  useEffect(() => {
    prepareCart();
    if (!hotelUid) return;
    getSuppliers(hotelUid).then((loadedSuppliers) => { if (isCurrent()) setSuppliers(Array.isArray(loadedSuppliers) ? loadedSuppliers : []); })
      .catch((failure) => { if (isCurrent()) setSupplierError(failure?.message || "Supplier filters could not be loaded."); });
    getOutlets(hotelUid).then((loadedOutlets) => { if (isCurrent()) setOutlets(loadedOutlets || []); })
      .catch((failure) => { if (isCurrent()) setOutletError(failure?.message || "Outlets could not be loaded."); });
  }, [hotelUid]);

  useEffect(() => {
    if (!hotelUid) return;
    setPageStartCursors({ 0: null });
    loadProductsPage(0, null);
  }, [hotelUid, debouncedSearchTerm, selectedSupplierId, selectedStatus]);

  const supplierOptions = useMemo(
    () =>
      suppliers
        .map((supplier) => {
          const supplierId = String(supplier.id || "").trim();
          const supplierName = String(supplier.supplierName || supplier.name || supplierId).trim();
          return supplierId ? { id: supplierId, name: supplierName || supplierId } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [suppliers]
  );

  const rows = useMemo(() => products.map((product) => {
    const options = productPurchaseOptions(product);
    const option = options.find((candidate) => candidate.id === (selectedOptions[product.id] || "default")) || options[0];
    return {
      ...product, options, purchaseOptionId: option?.id || "", selectedOption: option,
      purchaseUnit: option?.purchaseUnit || "",
      contentLabel: option ? `${formatContent({ ...product, ...option })}${option.priceRequiresDateReview ? " · dated version" : ""}` : "Legacy packages need review",
      priceLabel: formatPurchasePrice(option, product.currency, product.priceBasis, { approvedScheduledPrice: hasApprovedScheduledPrice(product) }),
      orderable: canAddPurchaseOptionToDraftCart(product, option),
    };
  }), [products, selectedOptions]);

  const handleAddProduct = async (product) => {
    if (cartBlocked || cartLock.current || !hotelUid || !product.orderable || !isCurrent()) return;
    cartLock.current = true;
    const qty = Math.max(1, Number(qtyByProductId[product.id] || 1));
    setSavingId(product.id); setError("");
    try {
      const args = [hotelUid, shoppingCart.id, product, qty, product.purchaseOptionId, shoppingCart.revision ?? 0];
      if (selectedOutlet?.id) args.push(selectedOutlet.id);
      const result = await addSupplierProductToShoppingCart(...args);
      if (!isCurrent()) return;
      if (!Number.isSafeInteger(result?.revision) || result.revision < 0) throw new Error("The saved cart revision could not be confirmed. Refresh before continuing.");
      minimumCartRevision.current = Math.max(minimumCartRevision.current, result.revision);
      setCartNeedsRefresh(true);
      const refreshed = await getShoppingCart(hotelUid, shoppingCart.id, { minimumRevision: result.revision });
      if (!refreshed || !Number.isSafeInteger(refreshed.revision ?? 0) || (refreshed.revision ?? 0) < minimumCartRevision.current) throw new Error("The updated cart could not be verified. Refresh before adding another package.");
      if (isCurrent()) { setShoppingCart(refreshed); setCartNeedsRefresh(false); }
    } catch (failure) { if (isCurrent()) { setCartNeedsRefresh(true); setError(failure?.message || "Could not add this package to the cart."); } }
    finally { cartLock.current = false; if (isCurrent()) setSavingId(""); }
  };

  const columns = [
    {
      key: "image",
      label: "Image",
      sortable: false,
      render: (row) => <SupplierProductImage hotelUid={hotelUid} product={row} className="h-14 w-14" />,
    },
    {
      key: "supplier",
      label: "Supplier",
      render: (row) => row.supplierName || row.supplierId || "-",
      sortValue: (row) => String(row.supplierName || row.supplierId || ""),
    },
    { key: "supplierProductName", label: "Product" },
    { key: "supplierSku", label: "SKU" },
    { key: "purchaseUnit", label: "Purchase option", sortable: false, render: (row) => <div className="min-w-[11rem]"><Combobox aria-label={`Purchase option for ${row.supplierProductName}`} options={row.options} value={row.selectedOption || null} disabled={!row.options.length || Boolean(savingId)} onChange={(option) => { if (option) setSelectedOptions((current) => ({ ...current, [row.id]: option.id })); }} displayValue={(option) => option.purchaseUnit} getOptionValue={(option) => option.id} placeholder="Review legacy packages" className="ht-field" /></div> },
    { key: "contentLabel", label: "Content" },
    {
      key: "qty",
      label: "Qty",
      sortable: false,
      render: (row) => (
        <input
          type="number"
          min="1"
          value={qtyByProductId[row.id] || 1}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) =>
            setQtyByProductId((prev) => ({
              ...prev,
              [row.id]: Math.max(1, Number(event.target.value || 1)),
            }))
          }
          className="w-20 border border-gray-300 rounded px-2 py-1 text-sm"
        />
      ),
    },
    { key: "priceLabel", label: "Indicative price" },
    {
      key: "action",
      label: "Action",
      sortable: false,
      render: (row) => (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            handleAddProduct(row);
          }}
          disabled={cartBlocked || !row.orderable}
          className="bg-brand-800 text-white rounded px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
        >
          {savingId === row.id ? "Adding..." : "Add"}
        </button>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <ProcurementPage className="space-y-6">
        <PendingCartCommand hotelUid={hotelUid} cartId={shoppingCart?.id || "active"} inFlight={preparingCart || Boolean(savingId)} onPendingChange={setPendingCommand} onComplete={async (result) => { if (!isCurrent()) return; minimumCartRevision.current = Math.max(minimumCartRevision.current, result.revision); setCartNeedsRefresh(true); const cart = await getShoppingCart(hotelUid, result.cartId, { minimumRevision: minimumCartRevision.current }); if (!cart) throw new Error("The reconciled cart could not be found. Refresh before continuing."); if (isCurrent()) { setShoppingCart(cart); setCartNeedsRefresh(false); setError(""); } }} />
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {preparingCart && <p role="status" className="text-sm text-slate-600">Preparing your shopping cart… Products can be added as soon as it is ready.</p>}
        {!preparingCart && (!shoppingCart?.id || cartNeedsRefresh) && !pendingCommand && <button type="button" onClick={prepareCart} className="ht-button-secondary">{cartNeedsRefresh ? "Refresh cart" : "Retry cart preparation"}</button>}
        {supplierError && <p role="status" className="text-sm text-amber-800">Supplier filter unavailable: {supplierError} You can still choose products.</p>}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="text-xs uppercase tracking-wider text-slate-500">Purchasing & inventory</p><h1 className="text-2xl font-semibold">New order</h1><p className="mt-1 text-sm text-slate-600">Choose supplier packages, then review your cart before placing an order.</p><p className="mt-1 text-xs text-slate-600">Catalog prices are indicative. Order preview checks applicable approved prices against the supplier's order-date or delivery-date agreement.</p></div>
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={() => navigate("/orders")}
                className="inline-flex items-center gap-2 border border-gray-300 rounded px-3 py-2 text-sm font-semibold hover:bg-gray-100"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>
              <button
                type="button"
                disabled={preparingCart || !shoppingCart?.id || Boolean(savingId) || cartNeedsRefresh}
                onClick={() => shoppingCart?.id && navigate(`/orders/cart/${shoppingCart.id}`)}
                className="relative inline-flex items-center gap-2 bg-brand-800 text-white rounded px-3 py-2 text-sm font-semibold hover:bg-brand-950"
              >
                <ShoppingCart className="w-4 h-4" />
                Shopping Cart
                <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 rounded-full bg-white text-brand-800 text-xs px-1 font-bold">
                  {cartCount}
                </span>
              </button>
            </div>
          </div>

          <div className="mt-4 max-w-md"><label className="text-sm font-semibold">Order for outlet</label><Combobox aria-label="Order for outlet" options={[{ id: "", name: "Assign later in cart" }, ...outlets]} value={selectedOutlet} onChange={setSelectedOutlet} displayValue={(outlet) => outlet.name || "Unnamed outlet"} getOptionValue={(outlet) => outlet.id} placeholder="Assign later in cart" disabled={Boolean(savingId)} className="ht-field" /><p className="mt-1 text-xs text-slate-600">New packages go to this outlet in the shared hotel cart. The same package can have a separate line for each outlet.</p>{outletError && <p className="mt-1 text-xs text-amber-800">{outletError} You can assign outlets in the cart.</p>}</div>

          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <input
              type="search"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search supplier products..."
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
            />
            <Combobox aria-label="Filter supplier" options={[{ id: "", name: "All suppliers" }, ...supplierOptions]} value={supplierOptions.find((supplier) => supplier.id === selectedSupplierId) || null} onChange={(supplier) => setSelectedSupplierId(supplier?.id || "")} displayValue={(supplier) => supplier.name} getOptionValue={(supplier) => supplier.id} placeholder="All suppliers" className="ht-field" />
            <select
              value={selectedStatus}
              onChange={(event) => setSelectedStatus(event.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </Card>

        {loading ? (
          <p className="text-sm text-gray-600">Loading supplier products...</p>
        ) : (
          <DataListTable columns={columns} rows={rows} emptyMessage="No supplier products found." />
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              const previousPage = pageIndex - 1;
              if (previousPage >= 0) {
                loadProductsPage(previousPage, pageStartCursors[previousPage] || null);
              }
            }}
            disabled={pageIndex === 0 || loading}
            className="border border-gray-300 rounded px-3 py-1 text-sm disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm text-gray-600">Page {pageIndex + 1}</span>
          <button
            type="button"
            onClick={() =>
              hasMorePages &&
              loadProductsPage(pageIndex + 1, pageStartCursors[pageIndex + 1] || null)
            }
            disabled={!hasMorePages || loading}
            className="border border-gray-300 rounded px-3 py-1 text-sm disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </ProcurementPage>
    </div>
  );
}

export default function OrderCreatePage() {
  const context = useHotelContext();
  const session = useRef({ actor: auth.currentUser, sequence: 0 });
  if (session.current.actor !== auth.currentUser) session.current = { actor: auth.currentUser, sequence: session.current.sequence + 1 };
  const access = JSON.stringify([context.permissions || [], context.subscriptionActive, context.subscription]);
  return <ScopedOrderCreatePage key={`${context.hotelUid}:${auth.currentUser?.uid || ""}:${session.current.sequence}:${access}`} />;
}
