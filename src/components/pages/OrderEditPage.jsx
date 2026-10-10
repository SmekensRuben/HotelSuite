import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getOrderById, updateOrder } from "../../services/firebaseOrders";
import AsyncError from "../shared/AsyncError";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { useStaffDisplayNames } from "../../hooks/useStaffDisplayNames";

function formatContent(item) {
  const amount = Number(item?.baseUnitsPerPurchaseUnit || 0);
  const unit = String(item?.baseUnit || "").trim();
  if (!(amount > 0) || !unit) return "-";
  return `${amount} ${unit}`;
}

export default function OrderEditPage() {
  const { orderId } = useParams();
  const { hotelUid } = useHotelContext();
  return <ScopedOrderEdit key={`${hotelUid}:${orderId}`} hotelUid={hotelUid} orderId={orderId} />;
}

function ScopedOrderEdit({ hotelUid, orderId }) {
  const navigate = useNavigate();
  const scopeKey = `${hotelUid}:${orderId}`;
  const load = useCallback(() => getOrderById(hotelUid, orderId), [hotelUid, orderId]);
  const query = useScopedAsync({ scopeKey, enabled: Boolean(hotelUid && orderId), load });
  const order = query.data;
  const loading = query.loading;
  const { createdByName } = useStaffDisplayNames({ hotelUid, scopeKey, record: order });
  const mounted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [editableItems, setEditableItems] = useState([]);

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

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setDeliveryDate(order?.deliveryDate || "");
    setEditableItems(Array.isArray(order?.products) ? order.products : []);
  }, [order]);

  if (loading) {
    return (
      <div className="min-h-screen bg-canvas text-gray-900">
        <HeaderBar today={today} onLogout={handleLogout} />
        <PageContainer>
          <p role="status" className="text-sm text-gray-600">Loading order...</p>
        </PageContainer>
      </div>
    );
  }

  if (query.error) return <div className="min-h-screen bg-canvas text-gray-900"><HeaderBar today={today} onLogout={handleLogout} /><PageContainer><AsyncError error={query.error} onRetry={query.retry} label="Could not load this order." /></PageContainer></div>;

  if (!order) {
    return (
      <div className="min-h-screen bg-canvas text-gray-900">
        <HeaderBar today={today} onLogout={handleLogout} />
        <PageContainer>
          <Card><p className="text-sm text-gray-600">Order niet gevonden.</p></Card>
        </PageContainer>
      </div>
    );
  }

  if (order.status !== "Created" || order.dispatchRequestId) {
    return (
      <div className="min-h-screen bg-canvas text-gray-900">
        <HeaderBar today={today} onLogout={handleLogout} />
        <PageContainer>
          <Card>
            <p className="text-sm text-gray-600">Alleen orders met status Created kunnen bewerkt worden.</p>
            <button type="button" onClick={() => navigate(`/orders/${orderId}`)} className="mt-3 px-4 py-2 border border-gray-300 rounded font-semibold hover:bg-gray-100">Terug</button>
          </Card>
        </PageContainer>
      </div>
    );
  }

  const rows = editableItems.map((item, index) => {
    const unitPrice = Number(item.pricePerPurchaseUnit || 0);
    const qty = Number(item.qtyPurchaseUnits || 0);
    return {
      id: `${item.supplierProductId || "row"}-${index}`,
      supplierProductName: item.supplierProductName || "-",
      supplierSku: item.supplierSku || "-",
      purchaseUnit: item.purchaseUnit || "-",
      content: formatContent(item),
      qty,
      price: `${unitPrice.toFixed(2)} ${item.currency || order.currency || "EUR"}`,
      subtotal: `${(unitPrice * qty).toFixed(2)} ${item.currency || order.currency || "EUR"}`,
      rowIndex: index,
    };
  });

  const columns = [
    { key: "supplierProductName", label: "Product" },
    { key: "supplierSku", label: "SKU" },
    { key: "purchaseUnit", label: "Purchase Unit" },
    { key: "content", label: "Content" },
    {
      key: "qtyEditor",
      label: "Qty",
      sortable: false,
      render: (row) => (
        <input
          type="number"
          min="1"
          value={Number(editableItems[row.rowIndex]?.qtyPurchaseUnits || 1)}
          onChange={(event) => {
            const nextQty = Math.max(1, Number(event.target.value || 1));
            setEditableItems((prev) => prev.map((entry, i) => (i === row.rowIndex ? { ...entry, qtyPurchaseUnits: nextQty } : entry)));
          }}
          className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
        />
      ),
    },
    { key: "price", label: "Prijs" },
    { key: "subtotal", label: "Subtotaal" },
    {
      key: "actions",
      label: "Actions",
      sortable: false,
      render: (row) => (
        <button
          type="button"
          onClick={() => setEditableItems((prev) => prev.filter((_, i) => i !== row.rowIndex))}
          className="text-xs font-semibold text-red-700 hover:text-red-900"
        >
          Remove line
        </button>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-canvas text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        {saveError && <p role="alert" className="rounded-lg bg-red-50 p-4 text-red-800">{saveError}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold">Edit order detail</h1>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                if (!deliveryDate || editableItems.length === 0) return;
                setBusy(true);
                setSaveError("");
                try {
                  const actor = auth.currentUser?.uid || "unknown";
                  await updateOrder(hotelUid, orderId, { deliveryDate, products: editableItems }, actor, order.revision || 0);
                  if (mounted.current) navigate(`/orders/${orderId}`);
                } catch (error) { if (mounted.current) setSaveError(error.message || "Reload and review the order before saving."); }
                finally { if (mounted.current) setBusy(false); }
              }}
              disabled={!deliveryDate || editableItems.length === 0 || busy}
              className="px-4 py-2 rounded bg-brand-800 text-white font-semibold hover:bg-brand-950 disabled:opacity-50"
            >
              {busy ? "Saving..." : "Save"}
            </button>
            <button type="button" onClick={() => navigate(`/orders/${orderId}`)} className="px-4 py-2 border border-gray-300 rounded font-semibold hover:bg-gray-100">Cancel</button>
          </div>
        </div>

        <Card>
          <div className="grid gap-3 md:grid-cols-3 text-sm">
            <p><span className="font-semibold">Status:</span> {order.status}</p>
            <p><span className="font-semibold">Supplier:</span> {order.supplierId || "-"}</p>
            <p><span className="font-semibold">Created By:</span> {createdByName}</p>
            <label className="md:col-span-2 text-sm font-semibold text-gray-700">
              Delivery Date
              <input type="date" value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)} className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
            </label>
          </div>
        </Card>

        <DataListTable columns={columns} rows={rows} emptyMessage="Geen orderregels meer." />
      </PageContainer>
    </div>
  );
}
