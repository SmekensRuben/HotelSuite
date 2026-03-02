import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ShoppingCart } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSupplierProducts } from "../../services/firebaseProducts";
import { addSupplierProductToShoppingCart, getOrCreateShoppingCart } from "../../services/firebaseShoppingCarts";

const PAGE_SIZE = 20;

export default function OrderCreatePage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [shoppingCart, setShoppingCart] = useState(null);
  const [products, setProducts] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMorePages, setHasMorePages] = useState(false);
  const [pageStartCursors, setPageStartCursors] = useState({ 0: null });

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

    setLoading(true);
    const normalizedStatus = selectedStatus.trim().toLowerCase();
    const activeFilter = normalizedStatus === "active" ? true : normalizedStatus === "inactive" ? false : null;

    const result = await getSupplierProducts(hotelUid, {
      pageSize: PAGE_SIZE,
      cursor,
      searchTerm: debouncedSearchTerm,
      supplierId: selectedSupplierId,
      active: activeFilter,
    });

    setProducts(result.products || []);
    setHasMorePages(result.hasMore);
    setPageIndex(nextPageIndex);

    if (result.hasMore && result.cursor) {
      setPageStartCursors((prev) => ({ ...prev, [nextPageIndex + 1]: result.cursor }));
    }

    setLoading(false);
  };

  useEffect(() => {
    const init = async () => {
      if (!hotelUid) return;
      const actor = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
      const cart = await getOrCreateShoppingCart(hotelUid, actor);
      setShoppingCart(cart);
    };

    init();
  }, [hotelUid]);

  useEffect(() => {
    if (!hotelUid) return;
    setPageStartCursors({ 0: null });
    loadProductsPage(0, null);
  }, [hotelUid, debouncedSearchTerm, selectedSupplierId, selectedStatus]);

  const supplierIds = useMemo(() => {
    const values = new Set(products.map((product) => String(product.supplierId || "").trim()).filter(Boolean));
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [products]);

  const handleAddProduct = async (product) => {
    if (!shoppingCart?.id || !hotelUid) return;
    setSavingId(product.id);
    await addSupplierProductToShoppingCart(hotelUid, shoppingCart.id, product, 1);
    const refreshed = await getOrCreateShoppingCart(hotelUid, auth.currentUser?.uid || "unknown");
    setShoppingCart(refreshed);
    setSavingId("");
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer>
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold">Nieuwe Order</h1>
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={() => navigate("/orders")}
                className="inline-flex items-center gap-2 border border-gray-300 rounded px-3 py-2 text-sm font-semibold hover:bg-gray-100"
              >
                <ArrowLeft className="w-4 h-4" />
                Terug
              </button>
              <button
                type="button"
                onClick={() => shoppingCart?.id && navigate(`/orders/cart/${shoppingCart.id}`)}
                className="relative inline-flex items-center gap-2 bg-blue-600 text-white rounded px-3 py-2 text-sm font-semibold hover:bg-blue-700"
              >
                <ShoppingCart className="w-4 h-4" />
                Shopping Cart
                <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 rounded-full bg-white text-blue-700 text-xs px-1 font-bold">
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
              placeholder="Zoek supplierproduct..."
              className="border border-gray-300 rounded px-3 py-2"
            />
            <select
              value={selectedSupplierId}
              onChange={(event) => setSelectedSupplierId(event.target.value)}
              className="border border-gray-300 rounded px-3 py-2"
            >
              <option value="">Alle suppliers</option>
              {supplierIds.map((supplierId) => (
                <option key={supplierId} value={supplierId}>
                  {supplierId}
                </option>
              ))}
            </select>
            <select
              value={selectedStatus}
              onChange={(event) => setSelectedStatus(event.target.value)}
              className="border border-gray-300 rounded px-3 py-2"
            >
              <option value="">Alle statussen</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>

          {loading ? (
            <p className="mt-6 text-sm text-gray-600">Supplier products laden...</p>
          ) : (
            <div className="mt-6 overflow-x-auto">
              <table className="min-w-full border border-gray-200 rounded">
                <thead className="bg-gray-100 text-xs uppercase text-gray-600">
                  <tr>
                    <th className="text-left px-4 py-2">Supplier</th>
                    <th className="text-left px-4 py-2">Product</th>
                    <th className="text-left px-4 py-2">SKU</th>
                    <th className="text-left px-4 py-2">Purchase Unit</th>
                    <th className="text-right px-4 py-2">Prijs</th>
                    <th className="text-right px-4 py-2">Actie</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => (
                    <tr key={product.id} className="border-t border-gray-200 text-sm">
                      <td className="px-4 py-2">{product.supplierId || "-"}</td>
                      <td className="px-4 py-2">{product.supplierProductName || "-"}</td>
                      <td className="px-4 py-2">{product.supplierSku || "-"}</td>
                      <td className="px-4 py-2">{product.purchaseUnit || "-"}</td>
                      <td className="px-4 py-2 text-right">
                        {Number(product.pricePerPurchaseUnit || 0).toFixed(2)} {product.currency || "EUR"}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleAddProduct(product)}
                          disabled={savingId === product.id}
                          className="bg-blue-600 text-white rounded px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                        >
                          {savingId === product.id ? "Toevoegen..." : "Toevoegen"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2">
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
              Vorige
            </button>
            <span className="text-sm text-gray-600">Pagina {pageIndex + 1}</span>
            <button
              type="button"
              onClick={() => hasMorePages && loadProductsPage(pageIndex + 1, pageStartCursors[pageIndex + 1] || null)}
              disabled={!hasMorePages || loading}
              className="border border-gray-300 rounded px-3 py-1 text-sm disabled:opacity-50"
            >
              Volgende
            </button>
          </div>
        </Card>
      </PageContainer>
    </div>
  );
}
