import React, { useState } from "react";
import { Link } from "react-router-dom";
import ProductProposalEditor from "./ProductProposalEditor";

const format = (value) => value === null || value === undefined || value === "" ? "Unknown / cleared" : typeof value === "boolean" ? value ? "Yes" : "No" : Array.isArray(value) ? value.length ? value.map((entry) => typeof entry === "object" ? JSON.stringify(entry) : entry).join("; ") : "None recorded" : typeof value === "object" ? JSON.stringify(value) : String(value);
const label = (value) => value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase());
const terminal = new Set(["applied", "skipped"]);
const statusLabel = (row) => row.status === "ready" ? row.action === "create" ? "New product" : "Change" : label(row.status || "Awaiting review");

export function productProposalName(row = {}) {
  const candidates = [row.proposed?.name, row.proposed?.supplierProductName, row.patch?.name, row.patch?.supplierProductName, row.original?.name, row.original?.supplierProductName, row.rowId];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim().slice(0, 200) || "Product proposal";
}

export default function ProductProposalReviewRow({ hotelUid, row, rows, checked, eligible, canEdit, canReadCatalog, canReadSuppliers, disabled, onSelect, onApprove, onSkip, onCorrect }) {
  const [editing, setEditing] = useState(false);
  const changedFields = [...new Set([...Object.keys(row.patch || {}), ...Object.keys(row.current || {}).filter((key) => JSON.stringify(row.current[key]) !== JSON.stringify(row.original?.[key]))])];
  const dependency = rows.find((item) => item.rowId === row.catalogRowId);
  const resultId = row.result?.productId || (row.status === "applied" ? row.productId : null);
  const headerProduct = { ...row.original, ...row.proposed, ...row.patch };
  const detail = [row.kind === "catalog" ? "Catalog Product" : "Supplier Product", ...[headerProduct.supplierSku, headerProduct.brand, headerProduct.baseUnit].filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim().slice(0, 200))].join(" · ");
  const correct = async (correction) => { const saved = await onCorrect(correction); if (saved) setEditing(false); };
  return <article aria-label={`Product proposal: ${productProposalName(row)}`} className="space-y-4 rounded-2xl border border-stone-200 bg-white p-4 sm:p-5">
    <header className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-start gap-3"><input type="checkbox" aria-label={`Select ${row.rowId}`} checked={checked} disabled={disabled || !eligible} onChange={(event) => onSelect(event.target.checked)} className="mt-1" /><div><h2 className="break-words font-semibold text-brand-950">{productProposalName(row)}</h2><p className="mt-1 break-words text-xs text-stone-500">{detail}</p></div></div></div><span className={`rounded-full px-2 py-1 text-xs ${row.status === "applied" ? "bg-green-50 text-green-900" : ["invalid", "conflict", "failed"].includes(row.status) ? "bg-amber-50 text-amber-950" : "bg-stone-100 text-stone-700"}`}>{statusLabel(row)}</span></header>
    {row.catalogRowId && <p className="rounded-lg bg-brand-50 p-3 text-xs text-brand-950">Catalog dependency: {dependency ? productProposalName(dependency) : row.catalogRowId} ({dependency?.status || "Unavailable"}). {dependency?.status === "applied" ? "The created catalog ID is reused." : "The catalog proposal must be approved first; selecting this row also selects its eligible dependency."}</p>}
    {row.issues?.length > 0 && <ul aria-label={`Validation for ${row.rowId}`} className="space-y-1 rounded-lg bg-amber-50 p-3 text-xs text-amber-950">{row.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.severity === "warning" ? "Review: " : "Blocked: "}{issue.message}</li>)}</ul>}
    {row.error && <p role="alert" className="text-xs text-red-700">{typeof row.error === "string" ? row.error : row.error.message || "The previous apply failed. Review its result before retrying."}</p>}
    {row.status === "conflict" && <p className="text-xs text-amber-950">The active product changed after this proposal was prepared. Compare its current values and explicitly reconcile the proposal before approval.</p>}
    <div className="overflow-x-auto"><table className="w-full min-w-[440px] text-left text-xs"><caption className="sr-only">Existing and proposed values for {productProposalName(row)}</caption><thead><tr className="border-b text-stone-500"><th className="py-2 pr-3 font-medium">Field</th><th className="py-2 pr-3 font-medium">Original</th>{row.current && <th className="py-2 pr-3 font-medium">Current</th>}<th className="py-2 font-medium">Proposal</th></tr></thead><tbody>{changedFields.map((field) => <tr key={field} className="border-b border-stone-100 align-top"><th className="py-2 pr-3 font-medium">{label(field)}</th><td className="max-w-xs break-words py-2 pr-3 text-stone-500">{row.action === "create" ? "New product" : format(row.original?.[field])}</td>{row.current && <td className="max-w-xs break-words py-2 pr-3 text-amber-950">{format(row.current[field])}</td>}<td className="max-w-xs break-words py-2 font-medium">{Object.hasOwn(row.patch || {}, field) ? format(row.patch[field]) : `Keep current: ${format(row.current?.[field] ?? row.original?.[field])}`}</td></tr>)}</tbody></table></div>
    {!changedFields.length && <p className="text-xs text-stone-500">No source fields were proposed. Existing information is preserved.</p>}
    <p className="text-xs text-stone-500">Fields absent from the source remain {row.action === "update" ? "unchanged" : "unknown"}. Empty or null proposed values explicitly clear information. Price changes use the existing approval and price-history rules.</p>
    {resultId && <p className="text-sm text-green-900">Applied · <Link className="underline" to={`/catalog/${row.kind === "catalog" ? "products" : "supplier-products"}/${encodeURIComponent(resultId)}`}>Open product</Link>{row.result?.internalSku ? ` · ${row.result.internalSku}` : ""}</p>}
    {!terminal.has(row.status) && <div className="flex flex-wrap gap-2"><button type="button" className="ht-button-primary" disabled={disabled || !eligible} onClick={onApprove}>{row.status === "failed" ? "Review and retry" : "Approve this proposal"}</button><button type="button" className="ht-button-secondary" disabled={disabled || !canEdit} onClick={() => setEditing(!editing)}>{editing ? "Close correction" : "Correct proposal"}</button><button type="button" className="text-xs text-stone-600 underline" disabled={disabled || !canEdit} onClick={onSkip}>Skip proposal</button>{!canEdit && <p className="self-center text-xs text-stone-500">Product {row.action} permission is required to review this row.</p>}</div>}
    {editing && <ProductProposalEditor key={`${row.rowId}:${row.reviewRevision || ""}:${row.status}`} hotelUid={hotelUid} row={row} rows={rows} disabled={disabled} canReadCatalog={canReadCatalog} canReadSuppliers={canReadSuppliers} onSave={correct} onCancel={() => setEditing(false)} />}
  </article>;
}
