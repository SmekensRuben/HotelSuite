import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import { getSuppliers } from "../../services/firebaseSuppliers";
import { Combobox } from "../ui/combobox";
import SupplierImportMappingsPanel from "../catalog/SupplierImportMappingsPanel";

const formats = [{ id: "xlsx", name: "Excel (.xlsx)" }, { id: "csv", name: "CSV" }, { id: "pdf", name: "PDF" },
  { id: "docx", name: "Word (.docx)" }, { id: "eml", name: "Email (.eml)" }, { id: "txt", name: "Text (.txt)" }];
const supplierName = (supplier) => supplier.supplierName || supplier.name || supplier.id;

export default function SupplierImportMappingSettingsSection() {
  const { hotelUid, scopeKey, current } = useProcurementSettingsScope();
  const [params, setParams] = useSearchParams();
  const [directory, setDirectory] = useState({ scopeKey: null, rows: [] }), [loading, setLoading] = useState(true), [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const suppliers = directory.scopeKey === scopeKey ? directory.rows : [];
  const supplier = suppliers.find((entry) => entry.id === params.get("supplier")) || null;
  const format = formats.find((entry) => entry.id === params.get("format"))?.id || "xlsx";
  useEffect(() => {
    let cancelled = false; setDirectory({ scopeKey, rows: [] }); setLoading(true); setError(null);
    getSuppliers(hotelUid).then((rows) => {
      if (!cancelled && current()) setDirectory({ scopeKey, rows: rows.filter((row) => row.archived !== true).sort((a, b) => supplierName(a).localeCompare(supplierName(b))) });
    }).catch((failure) => { if (!cancelled && current()) setError(failure); })
      .finally(() => { if (!cancelled && current()) setLoading(false); });
    return () => { cancelled = true; };
  }, [hotelUid, scopeKey, current, retry]);
  const select = (key, value) => setParams((previous) => { const next = new URLSearchParams(previous); next.set("section", "supplier-imports"); next.set(key, value); return next; }, { replace: true });
  return <section className="space-y-5" aria-label="Supplier import mapping settings">
    <div><h2 className="text-xl font-semibold">Supplier import mappings</h2><p className="mt-2 max-w-2xl text-sm text-gray-600">Manage purchase-package abbreviations outside an import. Choose a supplier and file format to view or save its rules. Rule changes affect future imports; existing reviews keep their original snapshot.</p></div>
    <div className="grid gap-4 rounded-2xl border border-gray-200 bg-white p-4 sm:grid-cols-2 sm:p-5">
      <label className="min-w-0 text-sm font-medium">Supplier<Combobox aria-label="Mapping supplier" value={supplier} options={suppliers} displayValue={supplierName} getOptionValue={(entry) => entry.id} onChange={(entry) => select("supplier", entry.id)} disabled={loading || Boolean(error)} loading={loading} placeholder="Search and select supplier" emptyMessage="No active suppliers found." /></label>
      <label className="text-sm font-medium">File format<select aria-label="Mapping file format" className="ht-field mt-1 w-full" value={format} onChange={(event) => select("format", event.target.value)}>{formats.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
    </div>
    {loading && <p role="status" className="animate-pulse text-sm text-gray-500">Loading supplier directory…</p>}
    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><p>The supplier directory could not be loaded.</p><button type="button" className="mt-2 underline" onClick={() => setRetry((value) => value + 1)}>Retry supplier directory</button></div>}
    {!loading && !error && !supplier && <p className="rounded-xl border border-dashed border-gray-200 p-5 text-sm text-gray-600">{suppliers.length ? "Select a supplier to manage its purchase-unit mappings." : "Add an active supplier before configuring import mappings."}</p>}
    {supplier && <SupplierImportMappingsPanel key={`${scopeKey}:${supplier.id}:${format}`} hotelUid={hotelUid} supplierId={supplier.id} supplierName={supplierName(supplier)} sourceFormat={format} standalone current={current} />}
  </section>;
}
