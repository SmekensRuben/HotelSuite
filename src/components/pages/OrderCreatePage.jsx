import React, { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ShoppingCart } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import ProcurementPage from "../layout/ProcurementPage";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { Combobox } from "../ui/combobox";
import PendingCartCommand from "../catalog/PendingCartCommand";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierProducts } from "../../services/firebaseProducts";
import { getSuppliers } from "../../services/firebaseSuppliers";
import {
  addSupplierProductToShoppingCart,
  getOrCreateShoppingCart,
  getShoppingCart,
} from "../../services/firebaseShoppingCarts";

import { productPurchaseOptions, formatPurchasePrice, knownPrice } from "../../utils/productPurchaseOptions";

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
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState("");
  const [error, setError] = useState("");
  const [selectedOptions, setSelectedOptions] = useState({});
  const mounted = useRef(true);
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

    if (!mounted.current || currentGeneration !== generation.current) return;
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

    } catch (failure) { if (mounted.current && currentGeneration === generation.current) setError(failure?.message || "Could not load supplier products."); }
    finally { if (mounted.current && currentGeneration === generation.current) setLoading(false); }
  };

  useEffect(() => {
    const init = async () => {
      if (!hotelUid) return;
      const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
      const [cart, loadedSuppliers] = await Promise.all([
        getOrCreateShoppingCart(hotelUid, actor),
        getSuppliers(hotelUid),
      ]);
      if (!mounted.current) return;
      setShoppingCart(cart);
      setSuppliers(Array.isArray(loadedSuppliers) ? loadedSuppliers : []);
    };

    init().catch((failure) => { if (mounted.current) setError(failure?.message || "Could not load the cart."); });
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
      purchaseUnit: option?.purchaseUnit || "", imageUrl: product.imageUrl || "",
      contentLabel: option ? formatContent({ ...product, ...option }) : "Legacy packages need review",
      priceLabel: formatPurchasePrice(option, product.currency, product.priceBasis),
      orderable: product.active !== false && product.archived !== true && Boolean(option?.purchaseUnit) && knownPrice(option?.pricePerPurchaseUnit) !== null,
    };
  }), [products, selectedOptions]);

  const handleAddProduct = async (product) => {
    if (!shoppingCart?.id || !hotelUid || !product.orderable) return;
    const qty = Math.max(1, Number(qtyByProductId[product.id] || 1));
    setSavingId(product.id); setError("");
    try {
      await addSupplierProductToShoppingCart(hotelUid, shoppingCart.id, product, qty, product.purchaseOptionId, shoppingCart.revision ?? 0);
      const refreshed = await getOrCreateShoppingCart(hotelUid);
      if (mounted.current) setShoppingCart(refreshed);
    } catch (failure) { if (mounted.current) setError(failure?.message || "Could not add this package to the cart."); }
    finally { if (mounted.current) setSavingId(""); }
  };

  const columns = [
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
    { key: "priceLabel", label: "Price" },
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
          disabled={Boolean(savingId) || !row.orderable}
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
        <PendingCartCommand hotelUid={hotelUid} cartId={shoppingCart?.id || "active"} onComplete={async (result) => { const cart = await getShoppingCart(hotelUid, result.cartId); if (mounted.current) { setShoppingCart(cart); setError(""); } }} />
        {error && <p role="alert" className="text-red-700">{error}</p>}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="text-xs uppercase tracking-wider text-slate-500">Purchasing & inventory</p><h1 className="text-2xl font-semibold">New order</h1><p className="mt-1 text-sm text-slate-600">Choose supplier packages, then review your cart before placing an order.</p></div>
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
  const { hotelUid } = useHotelContext();
  return <ScopedOrderCreatePage key={hotelUid} />;
}
