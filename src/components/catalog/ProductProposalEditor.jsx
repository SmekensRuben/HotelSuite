import React, { useCallback, useState } from "react";
import { Combobox } from "../ui/combobox";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import { getCatalogTaxonomy } from "../../services/firebaseSettings";
import { getSuppliers } from "../../services/firebaseSuppliers";
import { getCatalogProducts } from "../../services/firebaseProducts";
import { PRODUCT_BASE_UNITS } from "../../utils/productPurchaseOptions";

const fieldClass = "mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const catalogFields = [
  ["name", "Name", "text", true], ["brand", "Brand"], ["description", "Description"],
  ["category", "Category", "category"], ["subcategory", "Subcategory", "subcategory"],
  ["baseUnit", "Physical base unit", "unit", true], ["gtin", "GTIN"], ["storageType", "Storage type"],
  ["allergens", "Allergens", "allergens"], ["notes", "Notes"],
  ["active", "Active", "boolean", true], ["inventoryTracked", "Track inventory", "boolean", true],
];
const supplierFields = [
  ["supplierId", "Supplier", "supplier", true], ["supplierSku", "Supplier SKU", "text", true],
  ["supplierProductName", "Supplier product name", "text", true], ["brand", "Brand"],
  ["baseUnit", "Physical base unit", "unit", true], ["purchaseUnit", "Purchase package", "text", true],
  ["baseUnitsPerPurchaseUnit", "Package content", "number", true], ["gtin", "Package GTIN"],
  ["currency", "Currency", "text", true], ["pricingModel", "Pricing model", "pricing", true],
  ["priceBasis", "Price basis", "basis", true], ["vatRate", "VAT rate (fraction from 0 to 1)", "number"],
  ["pricePerPurchaseUnit", "Package price", "number"], ["pricePerBaseUnit", "Base unit price", "number"],
  ["priceValidFrom", "Price valid from", "date"], ["priceValidUntil", "Price valid until", "date"],
  ["active", "Active", "boolean", true],
];
const has = (object, key) => Object.hasOwn(object || {}, key);
const cleared = (value) => value === null || value === "" || (Array.isArray(value) && !value.length);
const clearValue = (type) => ["number", "date", "catalog"].includes(type) ? null : type === "allergens" ? [] : "";

function PurchaseOptions({ options, existingIds, onChange, disabled }) {
  return <div className="space-y-3">
    {options.map((option, index) => <fieldset key={option.id || index} className="grid gap-3 rounded-lg border bg-white p-3 sm:grid-cols-2"><legend className="px-1 text-xs">Package {index + 1} · {option.id}</legend>
      {[["purchaseUnit", "Package name", "text"], ["baseUnitsPerPurchaseUnit", "Package content", "number"], ["pricePerPurchaseUnit", "Package price", "number"], ["gtin", "Package GTIN", "text"]].map(([key, label, type]) => <div key={key}><label className="text-xs">{label}<input aria-label={`${label} for option ${index + 1}`} className={fieldClass} disabled={disabled} type={type} min={type === "number" ? 0 : undefined} step={type === "number" ? "0.000001" : undefined} value={option[key] ?? ""} onChange={(event) => onChange(options.map((item, position) => position === index ? { ...item, [key]: type === "number" ? event.target.value === "" ? null : Number(event.target.value) : event.target.value } : item))} /></label>{existingIds.has(option.id) && !Object.hasOwn(option, key) && <p className="mt-1 text-xs text-stone-500">Not proposed; the existing value is kept.</p>}{["pricePerPurchaseUnit", "gtin"].includes(key) && <button type="button" disabled={disabled} className="mt-1 text-xs text-stone-600 underline" aria-label={`Clear ${label.toLowerCase()} for option ${index + 1}`} onClick={() => onChange(options.map((item, position) => position === index ? { ...item, [key]: null } : item))}>Clear / unknown</button>}</div>)}
      {existingIds.has(option.id) ? <p className="text-xs text-stone-500 sm:col-span-2">Existing package retained. Remove individual existing packages in the Supplier Product editor after approval.</p> : <button type="button" disabled={disabled} className="text-left text-xs text-red-700 underline" onClick={() => onChange(options.filter((_, position) => position !== index))}>Remove proposed package {index + 1}</button>}
    </fieldset>)}
    <button type="button" disabled={disabled || options.length >= 20} className="ht-button-secondary" onClick={() => onChange([...options, { id: crypto.randomUUID(), purchaseUnit: "", baseUnitsPerPurchaseUnit: null, pricePerPurchaseUnit: null, gtin: null }])}>Add package option</button>
  </div>;
}

export default function ProductProposalEditor({ hotelUid, row, rows, disabled, canReadCatalog, canReadSuppliers, onSave, onCancel }) {
  const [patch, setPatch] = useState(() => ({ ...row.patch }));
  const [modes, setModes] = useState(() => Object.fromEntries((row.kind === "catalog" ? catalogFields : supplierFields).map(([key, , , required]) => [key, !has(row.patch, key) ? "keep" : !required && cleared(row.patch[key]) ? "clear" : "set"])));
  const [catalogRowId, setCatalogRowId] = useState(row.catalogRowId || null);
  const [linkMode, setLinkMode] = useState(row.catalogRowId ? "proposal" : has(row.patch, "catalogProductId") ? row.patch.catalogProductId ? "existing" : "clear" : "keep");
  const [acknowledgeCurrent, setAcknowledgeCurrent] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState("");
  const loadReferences = useCallback(async () => {
    const [taxonomy, suppliers] = await Promise.all([
      row.kind === "catalog" && canReadCatalog ? getCatalogTaxonomy(hotelUid) : Promise.resolve({ categories: [], subcategories: [] }),
      row.kind === "supplier" && canReadSuppliers ? getSuppliers(hotelUid) : Promise.resolve([]),
    ]);
    return { ...taxonomy, suppliers };
  }, [hotelUid, row.kind, canReadCatalog, canReadSuppliers]);
  const references = useScopedAsync({ scopeKey: `${hotelUid}:${row.rowId}`, load: loadReferences });
  const loadCatalog = useCallback(() => getCatalogProducts(hotelUid, { pageSize: 25, searchTerm: catalogQuery }), [hotelUid, catalogQuery]);
  const catalog = useScopedAsync({ scopeKey: `${hotelUid}:${row.rowId}:${catalogQuery}`, enabled: row.kind === "supplier" && linkMode === "existing" && canReadCatalog, load: loadCatalog });
  const base = row.current || row.original || {}, effective = { ...base, ...patch };
  const categories = (references.data?.categories || []).map((item) => item.name).filter(Boolean).sort();
  const categoryId = references.data?.categories?.find((item) => item.name === effective.category)?.id;
  const subcategories = (references.data?.subcategories || []).filter((item) => categoryId && item.categoryId === categoryId).map((item) => item.name).filter(Boolean).sort();
  const fields = row.kind === "catalog" ? catalogFields : supplierFields;
  const existingOptions = row.current?.purchaseOptions || row.original?.purchaseOptions || [];
  const existingOptionIds = new Set(Array.isArray(existingOptions) ? existingOptions.filter(Boolean).map((option) => option.id) : []);
  const omitOptions = () => setPatch((previous) => { const next = { ...previous }; delete next.purchaseOptions; return next; });
  const setField = (key, value) => {
    setPatch((previous) => ({ ...previous, [key]: value, ...(key === "category" && value !== effective.category ? { subcategory: "" } : {}) }));
    if (key === "category" && value !== effective.category) setModes((previous) => ({ ...previous, subcategory: "clear" }));
  };
  const mode = (key) => modes[key] || "keep";
  const changeMode = (key, type, value) => {
    setModes((previous) => ({ ...previous, [key]: value, ...(key === "category" && value === "keep" ? { subcategory: "keep" } : {}) }));
    if (value === "keep") setPatch((previous) => { const next = { ...previous }; delete next[key]; if (key === "category") delete next.subcategory; return next; });
    else setField(key, value === "clear" ? clearValue(type) : effective[key] ?? (type === "boolean" ? false : type === "allergens" ? [] : ""));
  };
  const select = (key, label, options) => <select aria-label={`Value for ${label}`} disabled={disabled} className={fieldClass} value={patch[key] ?? ""} onChange={(event) => setField(key, event.target.value)}><option value="">Choose a value</option>{options.map((item) => <option key={item} value={item}>{item}</option>)}</select>;
  const input = ([key, label, type = "text"]) => {
    if (type === "category" || type === "subcategory") return <Combobox aria-label={`Value for ${label}`} value={typeof patch[key] === "string" && patch[key] ? patch[key] : null} onChange={(value) => setField(key, value || "")} options={type === "category" ? categories : subcategories} displayValue={(value) => value} getOptionValue={(value) => value} disabled={disabled || references.loading || Boolean(references.error) || (type === "subcategory" && !categoryId)} loading={references.loading} placeholder={type === "subcategory" && !categoryId ? "Choose a category first" : `Choose an existing ${type}`} emptyMessage={`No existing ${type} matches. Manage classifications in Catalog Settings.`} />;
    if (type === "supplier") return <Combobox aria-label={`Value for ${label}`} value={references.data?.suppliers.find((item) => item.id === patch[key]) || null} onChange={(value) => setField(key, value?.id || "")} options={references.data?.suppliers || []} displayValue={(item) => item.name || item.supplierName || item.id} getOptionValue={(item) => item.id} disabled={disabled || !canReadSuppliers || references.loading || Boolean(references.error)} loading={references.loading} placeholder="Choose an existing supplier" />;
    if (type === "unit") return select(key, label, PRODUCT_BASE_UNITS);
    if (type === "pricing") return select(key, label, ["Per Purchase Unit", "Per Base Unit"]);
    if (type === "basis") return select(key, label, ["net", "gross", "unknown"]);
    if (type === "boolean") return <select aria-label={`Value for ${label}`} disabled={disabled} className={fieldClass} value={patch[key] === true ? "true" : patch[key] === false ? "false" : ""} onChange={(event) => setField(key, event.target.value === "true")}><option value="" disabled>Choose a value</option><option value="true">Yes</option><option value="false">No</option></select>;
    return <input aria-label={`Value for ${label}`} disabled={disabled} className={fieldClass} type={type === "number" ? "number" : type === "date" ? "date" : "text"} min={type === "number" ? 0 : undefined} step={type === "number" ? "0.000001" : undefined} value={type === "allergens" ? Array.isArray(patch[key]) ? patch[key].join(", ") : String(patch[key] ?? "") : patch[key] ?? ""} onChange={(event) => setField(key, type === "number" ? event.target.value === "" ? null : Number(event.target.value) : type === "allergens" ? event.target.value.split(",").map((item) => item.trim()).filter(Boolean) : event.target.value)} />;
  };
  const save = (event) => {
    event.preventDefault();
    const product = { ...patch };
    if (row.kind === "supplier") {
      if (linkMode === "keep" || linkMode === "proposal") delete product.catalogProductId;
      if (linkMode === "clear") product.catalogProductId = null;
    }
    onSave({ rowId: row.rowId, product, ...(row.kind === "supplier" ? { catalogRowId: linkMode === "proposal" ? catalogRowId : null } : {}),
      ...(row.status === "conflict" && acknowledgeCurrent ? { expectedRevision: row.currentRevision, acknowledgeCurrent: true } : {}) });
  };
  return <form onSubmit={save} className="space-y-4 rounded-xl border border-brand-100 bg-brand-50/40 p-4" aria-label={`Correct ${row.rowId}`}>
    <p className="text-xs text-stone-600">Only fields marked “Set value” or “Clear / unknown” are proposed. “Keep existing” preserves the current value for changes and leaves new information unknown. Internal SKUs are assigned by Hotel Toolkit. Images can be uploaded after approval.</p>
    {references.error && <p role="alert" className="text-sm text-red-700">{references.error.message}<button type="button" className="ml-2 underline" onClick={references.retry}>Retry references</button></p>}
    <div className="grid gap-4 sm:grid-cols-2">{fields.map((field) => {
      const [key, label, type = "text", required] = field, selectedMode = mode(key);
      return <div key={key}><label className="text-xs font-semibold" htmlFor={`${row.rowId}-${key}-mode`}>{label}</label><select id={`${row.rowId}-${key}-mode`} aria-label={`Treatment for ${label}`} value={selectedMode} disabled={disabled} className={fieldClass} onChange={(event) => changeMode(key, type, event.target.value)}><option value="keep">{row.action === "update" ? "Keep existing" : "Not provided"}</option><option value="set">Set value</option>{!required && <option value="clear">Clear / unknown</option>}</select>{selectedMode === "set" && input(field)}{selectedMode === "clear" && <p className="mt-1 text-xs text-amber-900">This value will explicitly be cleared.</p>}</div>;
    })}</div>
    {row.kind === "supplier" && <>
      <div className="space-y-2"><label className="block text-xs font-semibold">Catalog link<select aria-label="Catalog link treatment" className={fieldClass} value={linkMode} disabled={disabled} onChange={(event) => { setLinkMode(event.target.value); if (event.target.value !== "proposal") setCatalogRowId(null); }}><option value="keep">{row.action === "update" ? "Keep existing link" : "No link provided"}</option><option value="existing" disabled={!canReadCatalog}>Choose an existing catalog product</option><option value="proposal">Link a catalog proposal in this batch</option><option value="clear">Explicitly remove link</option></select></label>
        {linkMode === "existing" && <><Combobox aria-label="Existing catalog product" value={catalog.data?.products?.find((item) => item.id === patch.catalogProductId) || null} options={catalog.data?.products || []} displayValue={(item) => item.name} getOptionValue={(item) => item.id} onChange={(item) => setField("catalogProductId", item?.id || null)} onQueryChange={setCatalogQuery} filterOptions={false} loading={catalog.loading} disabled={disabled || !canReadCatalog} placeholder="Search and select a catalog product" />{patch.catalogProductId && <p className="text-xs text-stone-600">Selected catalog ID: {patch.catalogProductId}</p>}{catalog.error && <p role="alert" className="text-xs text-red-700">{catalog.error.message}<button type="button" className="ml-2 underline" onClick={catalog.retry}>Retry catalog search</button></p>}</>}
        {linkMode === "proposal" && <Combobox aria-label="Catalog proposal in this batch" value={rows.find((item) => item.kind === "catalog" && item.rowId === catalogRowId) || null} options={rows.filter((item) => item.kind === "catalog" && item.status !== "skipped")} displayValue={(item) => `${item.proposed?.name || item.patch?.name || item.rowId} · ${item.rowId} (${item.status})`} getOptionValue={(item) => item.rowId} onChange={(item) => setCatalogRowId(item?.rowId || null)} disabled={disabled} placeholder="Choose a catalog proposal" />}
      </div>
      <div><label className="text-xs font-semibold">Additional purchase options<select aria-label="Treatment for purchase options" className={fieldClass} disabled={disabled} value={!has(patch, "purchaseOptions") ? "keep" : "set"} onChange={(event) => { if (event.target.value === "keep") omitOptions(); else setField("purchaseOptions", Array.isArray(effective.purchaseOptions) ? effective.purchaseOptions : []); }}><option value="keep">{row.action === "update" ? "Keep existing packages" : "Not provided"}</option><option value="set">Review package options</option></select></label>{has(patch, "purchaseOptions") && <div className="mt-3 space-y-3"><PurchaseOptions options={Array.isArray(patch.purchaseOptions) ? patch.purchaseOptions.filter((item) => item && typeof item === "object") : []} existingIds={existingOptionIds} disabled={disabled} onChange={(value) => { if (!value.length) omitOptions(); else setField("purchaseOptions", value); }} />{Array.isArray(patch.purchaseOptions) && patch.purchaseOptions.length === 0 ? <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-950">This proposal explicitly clears all additional purchase options. Adding a package instead keeps unmentioned existing packages.</p> : <p className="text-xs text-stone-600">Packages are updated by their stable IDs. Unmentioned existing packages and omitted package fields are kept. To remove one existing package, use the Supplier Product editor after approval.</p>}<button type="button" className="text-xs text-red-700 underline" disabled={disabled} onClick={() => setField("purchaseOptions", [])}>Clear all additional options</button></div>}</div>
    </>}
    {row.status === "conflict" && <label className="flex gap-2 text-xs text-amber-950"><input type="checkbox" checked={acknowledgeCurrent} onChange={(event) => setAcknowledgeCurrent(event.target.checked)} disabled={disabled || !Number.isSafeInteger(row.currentRevision)} />I compared the current values shown above and want to revalidate this patch against revision {row.currentRevision ?? "unavailable"}.</label>}
    <div className="flex flex-wrap justify-end gap-2"><button type="button" className="ht-button-secondary" disabled={disabled} onClick={onCancel}>Cancel correction</button><button type="submit" className="ht-button-primary" disabled={disabled || (linkMode === "proposal" && !catalogRowId) || (row.status === "conflict" && !acknowledgeCurrent)}>Save correction for review</button></div>
  </form>;
}
