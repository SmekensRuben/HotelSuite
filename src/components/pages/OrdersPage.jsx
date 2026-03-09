import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarRange, Plus } from "lucide-react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getOrders, listOrderStatuses } from "../../services/firebaseOrders";
import { getUserDisplayName } from "../../services/firebaseUserManagement";

function toDateValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function isWithinRange(value, from, until) {
  if (!value) return false;
  if (from && value < from) return false;
  if (until && value > until) return false;
  return true;
}

function formatRangeLabel(from, until, fallback) {
  if (!from && !until) return fallback;
  if (from && until) return `${from} → ${until}`;
  if (from) return `Vanaf ${from}`;
  return `Tot ${until}`;
}

function DateRangePopover({ open, title, from, until, onFromChange, onUntilChange, onClear }) {
  if (!open) return null;

  return (
    <div className="absolute right-0 top-full z-10 mt-2 w-72 rounded-lg border border-gray-200 bg-white p-3 shadow-xl">
      <p className="text-sm font-semibold text-gray-800">{title}</p>
      <div className="mt-3 grid gap-2">
        <label className="text-xs text-gray-600">
          Van
          <input
            type="date"
            value={from}
            onChange={(event) => onFromChange(event.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-gray-600">
          Tot
          <input
            type="date"
            value={until}
            onChange={(event) => onUntilChange(event.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={onClear}
        className="mt-3 text-xs font-semibold text-blue-700 hover:text-blue-900"
      >
        Range wissen
      </button>
    </div>
  );
}

export default function OrdersPage() {
  const navigate = useNavigate();
  const { hotelUid } = useHotelContext();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createdByMap, setCreatedByMap] = useState({});

  const [selectedStatus, setSelectedStatus] = useState("");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdUntil, setCreatedUntil] = useState("");
  const [deliveryFrom, setDeliveryFrom] = useState("");
  const [deliveryUntil, setDeliveryUntil] = useState("");
  const [selectedSupplier, setSelectedSupplier] = useState("");
  const [selectedCreatedBy, setSelectedCreatedBy] = useState("");
  const [openRangePopover, setOpenRangePopover] = useState("");

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

  useEffect(() => {
    const loadOrders = async () => {
      if (!hotelUid) return;
      setLoading(true);
      const result = await getOrders(hotelUid);
      setOrders(result);
      setLoading(false);
    };

    loadOrders();
  }, [hotelUid]);

  useEffect(() => {
    const loadUserNames = async () => {
      const userIds = Array.from(
        new Set(orders.map((order) => String(order.createdBy || "").trim()).filter(Boolean))
      );
      const entries = await Promise.all(
        userIds.map(async (userId) => [userId, await getUserDisplayName(userId)])
      );
      setCreatedByMap(Object.fromEntries(entries));
    };

    loadUserNames();
  }, [orders]);

  const supplierOptions = useMemo(
    () =>
      Array.from(
        new Set(orders.map((order) => String(order.supplierId || "").trim()).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b)),
    [orders]
  );

  const createdByOptions = useMemo(
    () =>
      Array.from(new Set(orders.map((order) => String(order.createdBy || "").trim()).filter(Boolean)))
        .map((id) => ({ id, name: createdByMap[id] || id }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [orders, createdByMap]
  );

  const filteredRows = useMemo(() => {
    return orders
      .filter((order) => {
        if (selectedStatus && order.status !== selectedStatus) return false;
        if (selectedSupplier && order.supplierId !== selectedSupplier) return false;
        if (selectedCreatedBy && order.createdBy !== selectedCreatedBy) return false;

        const createdDate = toDateValue(order.createdAtDate);
        if ((createdFrom || createdUntil) && !isWithinRange(createdDate, createdFrom, createdUntil)) {
          return false;
        }

        const deliveryDate = String(order.deliveryDate || "").slice(0, 10);
        if ((deliveryFrom || deliveryUntil) && !isWithinRange(deliveryDate, deliveryFrom, deliveryUntil)) {
          return false;
        }

        return true;
      })
      .map((order) => ({
        ...order,
        supplier: order.supplierId || "-",
        createdByLabel: createdByMap[order.createdBy] || order.createdBy || "-",
        createdAtLabel: order.createdAtDate ? new Date(order.createdAtDate).toLocaleString() : "-",
        itemCount: Array.isArray(order.products) ? order.products.length : 0,
        totalLabel: `${Number(order.totalAmount || 0).toFixed(2)} ${order.currency || "EUR"}`,
      }));
  }, [
    orders,
    selectedStatus,
    selectedSupplier,
    selectedCreatedBy,
    createdFrom,
    createdUntil,
    deliveryFrom,
    deliveryUntil,
    createdByMap,
  ]);

  const columns = [
    { key: "status", label: "Status" },
    { key: "supplier", label: "Supplier" },
    { key: "deliveryDate", label: "Delivery Date" },
    { key: "createdByLabel", label: "Created By" },
    { key: "createdAtLabel", label: "Created At" },
    { key: "itemCount", label: "Items" },
    { key: "totalLabel", label: "Totaal" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={today} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold">Orders</h1>
            <p className="text-sm text-gray-500 mt-1">Overzicht van orders.</p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/orders/new")}
            className="inline-flex items-center gap-2 bg-blue-600 text-white rounded px-4 py-2 font-semibold hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" />
            Nieuwe order
          </button>
        </div>

        <Card>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
            <select
              value={selectedStatus}
              onChange={(event) => setSelectedStatus(event.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Alle statussen</option>
              {listOrderStatuses().map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>

            <select
              value={selectedSupplier}
              onChange={(event) => setSelectedSupplier(event.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Alle suppliers</option>
              {supplierOptions.map((supplierId) => (
                <option key={supplierId} value={supplierId}>
                  {supplierId}
                </option>
              ))}
            </select>

            <select
              value={selectedCreatedBy}
              onChange={(event) => setSelectedCreatedBy(event.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Alle creators</option>
              {createdByOptions.map((creator) => (
                <option key={creator.id} value={creator.id}>
                  {creator.name}
                </option>
              ))}
            </select>

            <div className="relative">
              <button
                type="button"
                onClick={() =>
                  setOpenRangePopover((prev) => (prev === "created" ? "" : "created"))
                }
                className="w-full inline-flex items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <span>{formatRangeLabel(createdFrom, createdUntil, "Created at range")}</span>
                <CalendarRange className="h-4 w-4 text-gray-500" />
              </button>
              <DateRangePopover
                open={openRangePopover === "created"}
                title="Created at range"
                from={createdFrom}
                until={createdUntil}
                onFromChange={setCreatedFrom}
                onUntilChange={setCreatedUntil}
                onClear={() => {
                  setCreatedFrom("");
                  setCreatedUntil("");
                }}
              />
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() =>
                  setOpenRangePopover((prev) => (prev === "delivery" ? "" : "delivery"))
                }
                className="w-full inline-flex items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <span>{formatRangeLabel(deliveryFrom, deliveryUntil, "Delivery date range")}</span>
                <CalendarRange className="h-4 w-4 text-gray-500" />
              </button>
              <DateRangePopover
                open={openRangePopover === "delivery"}
                title="Delivery date range"
                from={deliveryFrom}
                until={deliveryUntil}
                onFromChange={setDeliveryFrom}
                onUntilChange={setDeliveryUntil}
                onClear={() => {
                  setDeliveryFrom("");
                  setDeliveryUntil("");
                }}
              />
            </div>
          </div>
        </Card>

        {loading ? (
          <p className="text-sm text-gray-600">Orders laden...</p>
        ) : (
          <DataListTable
            columns={columns}
            rows={filteredRows}
            onRowClick={(order) => navigate(`/orders/${order.id}`)}
            emptyMessage="Geen orders gevonden."
          />
        )}
      </PageContainer>
    </div>
  );
}
