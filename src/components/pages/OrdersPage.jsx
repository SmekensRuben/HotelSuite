import React, { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarRange, Plus } from "lucide-react";
import PageShell from "../layout/PageShell";
import AsyncError from "../shared/AsyncError";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { Card } from "../layout/Card";
import DataListTable from "../shared/DataListTable";
import { useHotelContext } from "../../contexts/HotelContext";
import { usePermission } from "../../hooks/usePermission";
import { getOrders, listOrderStatuses } from "../../services/firebaseOrders";
import { getSuppliers } from "../../services/firebaseSuppliers";
import { getHotelUserDisplayName } from "../../services/firebaseUserManagement";

const EMPTY_ORDERS = Object.freeze([]);

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
        className="mt-3 text-xs font-semibold text-brand-800 hover:text-brand-950"
      >
        Range wissen
      </button>
    </div>
  );
}

export default function OrdersPage() {
  const { hotelUid } = useHotelContext();
  return <ScopedOrdersPage key={hotelUid} hotelUid={hotelUid} />;
}

function ScopedOrdersPage({ hotelUid }) {
  const navigate = useNavigate();
  const canReadSuppliers = usePermission("suppliers", "read");

  const [selectedStatus, setSelectedStatus] = useState("");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdUntil, setCreatedUntil] = useState("");
  const [deliveryFrom, setDeliveryFrom] = useState("");
  const [deliveryUntil, setDeliveryUntil] = useState("");
  const [selectedSupplier, setSelectedSupplier] = useState("");
  const [selectedCreatedBy, setSelectedCreatedBy] = useState("");
  const [openRangePopover, setOpenRangePopover] = useState("");

  const loadOrders = useCallback(() => getOrders(hotelUid), [hotelUid]);
  const query = useScopedAsync({ scopeKey: hotelUid, enabled: Boolean(hotelUid), load: loadOrders });
  const orders = query.data || EMPTY_ORDERS;
  const userIds = useMemo(() => [...new Set(orders.map((order) => String(order.createdBy || "").trim()).filter(Boolean))], [orders]);
  const loadStaffNames = useCallback(async () => {
    const names = await Promise.allSettled(userIds.map((userId) => getHotelUserDisplayName(hotelUid, userId)));
    return Object.fromEntries(names.map((name, index) => [userIds[index], name.status === "fulfilled" ? name.value : null]));
  }, [hotelUid, userIds]);
  const staffQuery = useScopedAsync({ scopeKey: `${hotelUid}:${JSON.stringify(userIds)}`, enabled: Boolean(hotelUid && userIds.length), load: loadStaffNames });
  const createdByMap = staffQuery.data || {};
  const loadSuppliers = useCallback(() => getSuppliers(hotelUid), [hotelUid]);
  const suppliersQuery = useScopedAsync({ scopeKey: `${hotelUid}:${canReadSuppliers}`, enabled: Boolean(hotelUid && canReadSuppliers), load: loadSuppliers });
  const supplierNameMap = useMemo(() => Object.fromEntries((suppliersQuery.data || []).map((supplier) => [supplier.id, String(supplier.name || "").trim() || supplier.id])), [suppliersQuery.data]);
  const loading = query.loading;

  const supplierOptions = useMemo(
    () =>
      Array.from(
        new Set(orders.map((order) => String(order.supplierId || "").trim()).filter(Boolean))
      )
        .map((supplierId) => ({ id: supplierId, name: supplierNameMap[supplierId] || orders.find((order) => order.supplierId === supplierId && order.supplierName)?.supplierName || supplierId }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [orders, supplierNameMap]
  );

  const createdByOptions = useMemo(
    () =>
      Array.from(new Set(orders.map((order) => String(order.createdBy || "").trim()).filter(Boolean)))
        .map((id) => ({ id, name: createdByMap[id] || orders.find((order) => order.createdBy === id && order.createdByName)?.createdByName || id }))
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
        supplier: supplierNameMap[order.supplierId] || order.supplierName || order.supplierId || "-",
        outlet: order.outletName || order.outletId || "-",
        createdByLabel: createdByMap[order.createdBy] || order.createdByName || order.createdBy || "-",
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
    supplierNameMap,
  ]);

  const columns = [
    { key: "status", label: "Status" },
    { key: "supplier", label: "Supplier" },
    { key: "outlet", label: "Outlet" },
    { key: "deliveryDate", label: "Delivery Date" },
    { key: "createdByLabel", label: "Created By" },
    { key: "createdAtLabel", label: "Created At" },
    { key: "itemCount", label: "Items" },
    { key: "totalLabel", label: "Totaal" },
  ];

  return (
    <PageShell>
      <AsyncError error={query.error} onRetry={query.retry} label="Could not load orders." />
      {canReadSuppliers && <AsyncError error={suppliersQuery.error} onRetry={suppliersQuery.retry} label="Could not load supplier names. Saved order names remain available." />}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold">Orders</h1>
            <p className="text-sm text-gray-500 mt-1">Overzicht van orders.</p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/orders/new")}
            className="inline-flex items-center gap-2 bg-brand-800 text-white rounded px-4 py-2 font-semibold hover:bg-brand-950"
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
              {supplierOptions.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
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
                className="w-full inline-flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
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
                className="w-full inline-flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
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
        ) : query.error ? null : (
          <DataListTable
            columns={columns}
            rows={filteredRows}
            onRowClick={(order) => navigate(`/orders/${order.id}`)}
            emptyMessage="Geen orders gevonden."
          />
        )}
    </PageShell>
  );
}
