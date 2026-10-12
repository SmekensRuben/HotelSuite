import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import PageShell from "../layout/PageShell";
import { Card } from "../layout/Card";
import { Combobox } from "../ui/combobox";
import AsyncError from "../shared/AsyncError";
import { auth } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { usePermission } from "../../hooks/usePermission";
import { getOutlets } from "../../services/firebaseSettings";
import { createSupplierOutletAccount, getSuppliers } from "../../services/firebaseSuppliers";

export default function SupplierOutletAccountCreatePage() {
  const { supplierId } = useParams();
  const { hotelUid } = useHotelContext();
  return <ScopedSupplierOutletAccountCreatePage key={`${hotelUid}:${supplierId}`} hotelUid={hotelUid} supplierId={supplierId} />;
}

function ScopedSupplierOutletAccountCreatePage({ hotelUid, supplierId }) {
  const navigate = useNavigate();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [selectedSupplierId, setSelectedSupplierId] = useState(supplierId || "");
  const [outletId, setOutletId] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const canManage = usePermission("suppliers", "update");
  const load = useCallback(async () => {
    const [suppliers, outlets] = await Promise.all([getSuppliers(hotelUid), getOutlets(hotelUid)]);
    return { suppliers, outlets: outlets.filter((outlet) => outlet.archived !== true) };
  }, [hotelUid]);
  const sources = useScopedAsync({ scopeKey: hotelUid, enabled: Boolean(hotelUid), load });
  const supplier = sources.data?.suppliers.find((entry) => entry.id === selectedSupplierId);
  const outlet = sources.data?.outlets.find((entry) => entry.id === outletId);

  const submit = async (event) => {
    event.preventDefault();
    if (!hotelUid || !canManage || saving || !supplier || !outlet || !accountNumber.trim()) return;
    setSaving(true); setError(null);
    try {
      await createSupplierOutletAccount(hotelUid, {
        supplierId: supplier.id, supplierName: supplier.name || "Unnamed supplier",
        outletId: outlet.id, outletName: outlet.name || "Unnamed outlet", accountNumber: accountNumber.trim(),
      }, auth.currentUser?.uid || "unknown");
      if (mounted.current) navigate(`/catalog/suppliers/${supplier.id}/outlet-accounts`);
    } catch (failure) { if (mounted.current) setError(failure); }
    finally { if (mounted.current) setSaving(false); }
  };

  return <PageShell variant="procurement" width="form">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div><p className="text-sm uppercase tracking-wide text-gray-500">Purchasing & Inventory</p><h1 className="text-3xl font-semibold">New supplier outlet account</h1><p className="mt-2 text-sm text-gray-600">Use a supplier account dedicated to one operational outlet.</p></div>
      <button type="button" onClick={() => navigate(`/catalog/suppliers/${supplierId}/outlet-accounts`)} className="rounded-lg border bg-white px-4 py-2 text-sm">Back</button>
    </div>
    <AsyncError error={sources.error} onRetry={sources.retry} label="Could not load suppliers and outlets." />
    <AsyncError error={error} label="Could not save the supplier outlet account." />
    <Card><form onSubmit={submit} className="grid gap-5 sm:grid-cols-2">
      <label className="space-y-1 text-sm font-medium">Supplier *<Combobox required value={supplier || null} options={sources.data?.suppliers || []} getOptionValue={(entry) => entry.id} displayValue={(entry) => entry.name || "Unnamed supplier"} onChange={(entry) => setSelectedSupplierId(entry?.id || "")} placeholder="Search suppliers" disabled={saving || sources.loading} /></label>
      <label className="space-y-1 text-sm font-medium">Outlet *<Combobox required value={outlet || null} options={sources.data?.outlets || []} getOptionValue={(entry) => entry.id} displayValue={(entry) => entry.name || "Unnamed outlet"} onChange={(entry) => setOutletId(entry?.id || "")} placeholder="Search outlets" disabled={saving || sources.loading} /></label>
      <label className="space-y-1 text-sm font-medium sm:col-span-2">Account number *<input required value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} disabled={saving} className="w-full rounded-lg border px-3 py-2" /></label>
      <div className="flex justify-end sm:col-span-2"><button type="submit" disabled={!canManage || saving || sources.loading || Boolean(sources.error) || !supplier || !outlet} className="rounded-lg bg-brand-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Saving…" : "Save account"}</button></div>
    </form></Card>
  </PageShell>;
}
