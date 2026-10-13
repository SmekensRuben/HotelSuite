import React, { useCallback, useEffect, useState } from "react";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSuppliers } from "../../services/firebaseSuppliers";
import { getCatalogProducts } from "../../services/firebaseProducts";
import { useScopedAsync } from "../../hooks/useScopedAsync";
import AsyncError from "../shared/AsyncError";
import { Combobox } from "../ui/combobox";
import { PRODUCT_BASE_UNITS } from "../../utils/productPurchaseOptions";
import { packageConversionLabel, productUnitLabel } from "../../utils/productUnitDisplay";

const stringNumber = (value) => value == null ? "" : String(value);
const nullableNumber = (value) => value === "" ? null : Number(value);
const inputClass = "rounded border border-gray-300 px-3 py-2 text-sm";

function initialForm(product = {}) {
  return {
    supplierId: product.supplierId || "", supplierSku: product.supplierSku || "",
    supplierProductName: product.supplierProductName || "", currency: product.currency || "EUR",
    pricingModel: product.pricingModel || "Per Purchase Unit", priceBasis: product.priceBasis || "unknown",
    vatPercent: product.vatRate == null ? "" : String(product.vatRate * 100),
    priceValidFrom: product.priceValidFrom || "", priceValidUntil: product.priceValidUntil || "",
    pricePerBaseUnit: stringNumber(product.pricePerBaseUnit), pricePerPurchaseUnit: stringNumber(product.pricePerPurchaseUnit),
    purchaseUnit: product.purchaseUnit || "", baseUnit: product.baseUnit || "",
    baseUnitsPerPurchaseUnit: stringNumber(product.baseUnitsPerPurchaseUnit),
    catalogProductId: product.catalogProductId || "", imageUrl: product.imageUrl || "", active: product.active !== false,
    purchaseOptions: (product.purchaseOptions || []).filter((option) => option.id !== "default").map((option) => ({ ...option, baseUnitsPerPurchaseUnit: stringNumber(option.baseUnitsPerPurchaseUnit), pricePerPurchaseUnit: stringNumber(option.pricePerPurchaseUnit) })),
  };
}

function Field({ title, children, wide = false }) {
  return <label className={`${wide ? "sm:col-span-2 " : ""}flex flex-col gap-1 text-sm font-semibold text-gray-700`}>{title}{children}</label>;
}

export default function SupplierProductFormFields({ initialData, onSubmit, savingLabel, submitLabel }) {
  const { hotelUid } = useHotelContext();
  const [form, setForm] = useState(() => initialForm(initialData));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [legacyReviewed, setLegacyReviewed] = useState(false);
  const legacyVariants = initialData?.hasVariants && !initialData?.purchaseOptions?.length;
  const loadSources = useCallback(async () => {
    const [suppliers, catalog] = await Promise.all([getSuppliers(hotelUid), getCatalogProducts(hotelUid)]);
    return { suppliers, catalog };
  }, [hotelUid]);
  const sources = useScopedAsync({ scopeKey: hotelUid, enabled: Boolean(hotelUid), load: loadSources });
  const supplierOptions = sources.data?.suppliers || [];
  const catalogOptions = (sources.data?.catalog || []).filter((product) => (product.active !== false && product.archived !== true) || product.id === form.catalogProductId);
  const linkedCatalog = catalogOptions.find((product) => product.id === form.catalogProductId);
  useEffect(() => { setForm(initialForm(initialData)); setLegacyReviewed(false); setError(""); }, [initialData, hotelUid]);
  const change = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const changeOption = (id, key, value) => setForm((current) => ({ ...current, purchaseOptions: current.purchaseOptions.map((option) => option.id === id ? { ...option, [key]: value } : option) }));
  const computedDefaultPrice = form.pricingModel === "Per Base Unit"
    ? (form.pricePerBaseUnit === "" || form.baseUnitsPerPurchaseUnit === "" ? null : Number((Number(form.pricePerBaseUnit) * Number(form.baseUnitsPerPurchaseUnit)).toFixed(6)))
    : nullableNumber(form.pricePerPurchaseUnit);

  const submit = async (event) => {
    event.preventDefault(); setError("");
    if (!PRODUCT_BASE_UNITS.includes(form.baseUnit)) { setError("Select a supported base unit."); return; }
    if (legacyVariants && !legacyReviewed) { setError("Review the old variants and replace them with explicit purchase options before saving."); return; }
    if (!sources.data?.suppliers.some((supplier) => supplier.id === form.supplierId)) { setError("Select an existing supplier from this hotel."); return; }
    if (form.priceBasis === "gross" && form.vatPercent === "") { setError("Enter the VAT rate for a gross price contract."); return; }
    if (form.priceValidFrom && form.priceValidUntil && form.priceValidFrom > form.priceValidUntil) { setError("Price valid from must not be after price valid until."); return; }
    const linked = sources.data?.catalog.find((product) => product.id === form.catalogProductId);
    if (form.catalogProductId && !linked) { setError("The catalog link is unavailable. Load or select an existing hotel catalog product."); return; }
    const dimensions = { g: "weight", kg: "weight", ml: "volume", l: "volume", each: "count" };
    if (linked && dimensions[linked.baseUnit] !== dimensions[form.baseUnit]) { setError("Supplier and catalog base units must have the same dimension."); return; }
    const payload = {
      supplierId: form.supplierId, supplierSku: form.supplierSku.trim(), supplierProductName: form.supplierProductName.trim(),
      currency: form.currency.trim().toUpperCase(), pricingModel: form.pricingModel,
      priceBasis: form.priceBasis, vatRate: form.priceBasis === "gross" && form.vatPercent !== "" ? Number(form.vatPercent) / 100 : null,
      priceValidFrom: form.priceValidFrom || null, priceValidUntil: form.priceValidUntil || null,
      pricePerBaseUnit: form.pricingModel === "Per Base Unit" ? nullableNumber(form.pricePerBaseUnit) : null,
      pricePerPurchaseUnit: computedDefaultPrice, purchaseUnit: form.purchaseUnit.trim(), baseUnit: form.baseUnit,
      baseUnitsPerPurchaseUnit: Number(form.baseUnitsPerPurchaseUnit), catalogProductId: form.catalogProductId || null,
      imageUrl: form.imageUrl.trim(), active: form.active,
      purchaseOptions: form.purchaseOptions.map((option) => ({ id: option.id, purchaseUnit: option.purchaseUnit.trim(), baseUnitsPerPurchaseUnit: Number(option.baseUnitsPerPurchaseUnit), pricePerPurchaseUnit: nullableNumber(option.pricePerPurchaseUnit) })),
    };
    setSaving(true);
    try { await onSubmit(payload); }
    catch (failure) { setError(failure?.message || "Could not save the supplier product."); }
    finally { setSaving(false); }
  };

  return <form onSubmit={submit} className="space-y-5">
    <AsyncError error={sources.error} onRetry={sources.retry} label="Could not load hotel suppliers and catalog products." />
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {legacyVariants && <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
      <p>Legacy variants have no selectable package identity. Review their quantities and prices, then enter explicit purchase options below.</p>
      <pre className="overflow-x-auto text-xs">{JSON.stringify(initialData.variants || [], null, 2)}</pre>
      <label className="flex gap-2"><input type="checkbox" checked={legacyReviewed} onChange={(event) => setLegacyReviewed(event.target.checked)} /> I reviewed and replaced the legacy variants.</label>
    </div>}
    <fieldset disabled={saving} className="grid gap-4 sm:grid-cols-2">
      <Field title="Supplier *"><Combobox required disabled={Boolean(initialData?.id && initialData?.supplierId)} value={supplierOptions.find((supplier) => supplier.id === form.supplierId) || null} options={supplierOptions} displayValue={(supplier) => supplier.name || "Unnamed supplier"} getOptionValue={(supplier) => supplier.id} onChange={(supplier) => change("supplierId", supplier?.id || "")} placeholder="Search hotel suppliers" loading={sources.loading} className={inputClass} />
        {form.supplierId && !sources.loading && !supplierOptions.some((supplier) => supplier.id === form.supplierId) && <span className="text-xs font-normal text-amber-700">The existing supplier is unavailable. Review this offer before saving.</span>}
      </Field>
      <Field title="Supplier SKU *"><input required value={form.supplierSku} onChange={(event) => change("supplierSku", event.target.value)} className={inputClass} /><span className="text-xs font-normal text-gray-500">Changing the SKU preserves the product's stable ID.</span></Field>
      <Field title="Supplier product name *" wide><input required value={form.supplierProductName} onChange={(event) => change("supplierProductName", event.target.value)} className={inputClass} /></Field>
      <Field title="Catalog product"><Combobox disabled={Boolean(initialData?.id && initialData?.catalogProductId)} value={linkedCatalog || null} options={catalogOptions} displayValue={(product) => `${product.name || "Unnamed catalog product"} (${product.baseUnit || "unit needs review"})`} getOptionValue={(product) => product.id} onChange={(product) => change("catalogProductId", product?.id || "")} placeholder="Unlinked — procurement only" allowClear loading={sources.loading} className={inputClass} />
        {form.catalogProductId && !sources.loading && !linkedCatalog && <span className="text-xs font-normal text-amber-700">The existing catalog link is unavailable. Its identity has been retained.</span>}
      </Field>
      <Field title="Supplier content unit *"><select required disabled={initialData?.productPolicyVersion === 1} value={form.baseUnit} onChange={(event) => change("baseUnit", event.target.value)} className={`${inputClass} disabled:bg-gray-100`}>
        <option value="">Choose a base unit</option>
        {form.baseUnit && !PRODUCT_BASE_UNITS.includes(form.baseUnit) && <option value={form.baseUnit} disabled>Legacy: {form.baseUnit} — select its meaning</option>}
        {PRODUCT_BASE_UNITS.map((unit) => <option key={unit} value={unit}>{productUnitLabel(unit)}</option>)}
      </select>{initialData?.productPolicyVersion === 1 && <span className="text-xs font-normal text-gray-500">Reviewed content units are fixed. Create a new supplier offer for a different unit.</span>}</Field>
      <p className="sm:col-span-2 text-sm text-gray-600">An established supplier/catalog identity is preserved. Create a new offer for a different item. Package contents are expressed in the supplier base unit and converted to the linked catalog unit. Weight and volume cannot be mixed.</p>
      <Field title="Currency *"><input required pattern="[A-Za-z]{3}" maxLength={3} value={form.currency} onChange={(event) => change("currency", event.target.value)} className={inputClass} /></Field>
      <Field title="Price basis"><select value={form.priceBasis} onChange={(event) => change("priceBasis", event.target.value)} className={inputClass}>
        <option value="unknown">Unknown — inventory cost unavailable</option><option value="net">Net (excluding VAT)</option><option value="gross">Gross (including VAT)</option>
      </select></Field>
      {form.priceBasis === "gross" && <Field title="VAT rate (%) *"><input required type="number" min="0" max="100" step="0.01" value={form.vatPercent} onChange={(event) => change("vatPercent", event.target.value)} className={inputClass} /></Field>}
      <Field title="Contract price valid from (optional)"><input type="date" value={form.priceValidFrom} max={form.priceValidUntil || undefined} onChange={(event) => change("priceValidFrom", event.target.value)} className={inputClass} /></Field>
      <Field title="Contract price valid until (optional)"><input type="date" value={form.priceValidUntil} min={form.priceValidFrom || undefined} onChange={(event) => change("priceValidUntil", event.target.value)} className={inputClass} /></Field>
      <p className="sm:col-span-2 text-xs text-gray-500">Enter dates only when provided by the supplier's price contract. Blank bounds remain unknown. Dates apply to all purchase options and qualify current price comparisons; they do not rewrite existing orders or receipts.</p>
      <Field title="Default pricing model"><select value={form.pricingModel} onChange={(event) => change("pricingModel", event.target.value)} className={inputClass}><option>Per Purchase Unit</option><option>Per Base Unit</option></select></Field>
      <Field title="Default purchase unit *"><input required value={form.purchaseUnit} onChange={(event) => change("purchaseUnit", event.target.value)} placeholder="e.g. case of 24 bottles" className={inputClass} /></Field>
      <Field title={`Default package content (${form.baseUnit || "base units"}) *`}><input required type="number" min="0.000001" max="1000000" step="0.000001" value={form.baseUnitsPerPurchaseUnit} onChange={(event) => change("baseUnitsPerPurchaseUnit", event.target.value)} className={inputClass} /></Field>
      <div className="sm:col-span-2 rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm">
        <p className="font-semibold text-gray-900">Physical stock-count conversion</p>
        {linkedCatalog ? <><p className="mt-1">{linkedCatalog.name}: stock counts use {productUnitLabel(linkedCatalog.baseUnit)}.</p><p className="mt-1">{packageConversionLabel(form.baseUnitsPerPurchaseUnit, form.baseUnit, linkedCatalog.baseUnit)}</p></> : <p className="mt-1 text-gray-600">{form.catalogProductId ? "The catalog details are unavailable, so this conversion cannot be verified." : "Link a catalog product to include received goods in catalog stock-count comparisons."}</p>}
        {linkedCatalog && linkedCatalog.inventoryTracked !== true && <p className="mt-2 text-amber-800">{linkedCatalog.inventoryTracked === false ? "Catalog inventory tracking is disabled." : "Catalog inventory tracking needs review."} This unit preview does not make receipts available to stock-count reports.</p>}
        {linkedCatalog && (linkedCatalog.active === false || linkedCatalog.archived === true) && <p className="mt-2 text-amber-800">The linked catalog product is inactive. Review the link before activating this offer.</p>}
        <p className="mt-2 text-xs text-gray-600">This is a unit preview. Orders preserve the reviewed package and receiving records quantities in the catalog unit; stock counts do not count supplier offers separately.</p>
      </div>
      <Field title={form.pricingModel === "Per Base Unit" ? "Price per base unit (blank = unknown)" : "Default package price (blank = unknown)"}>
        <input type="number" min="0" step="0.0001" value={form.pricingModel === "Per Base Unit" ? form.pricePerBaseUnit : form.pricePerPurchaseUnit} onChange={(event) => change(form.pricingModel === "Per Base Unit" ? "pricePerBaseUnit" : "pricePerPurchaseUnit", event.target.value)} className={inputClass} />
      </Field>
      {form.pricingModel === "Per Base Unit" && <p className="self-center text-sm">Default package price: {computedDefaultPrice == null ? "Unavailable" : `${computedDefaultPrice} ${form.currency}`}</p>}
      <div className="sm:col-span-2 space-y-3 rounded border border-gray-200 p-3">
        <h2 className="font-semibold">Additional purchase options</h2>
        <p className="text-sm text-gray-600">Each package keeps its own identity, quantity and price. Blank prices remain unknown.</p>
        {form.purchaseOptions.map((option) => <div key={option.id} className="grid gap-3 sm:grid-cols-3 border-t pt-3">
          <Field title="Package name *"><input required value={option.purchaseUnit} onChange={(event) => changeOption(option.id, "purchaseUnit", event.target.value)} className={inputClass} /></Field>
          <Field title={`Content (${form.baseUnit || "base units"}) *`}><input required type="number" min="0.000001" max="1000000" step="0.000001" value={option.baseUnitsPerPurchaseUnit} onChange={(event) => changeOption(option.id, "baseUnitsPerPurchaseUnit", event.target.value)} className={inputClass} /></Field>
          <Field title="Package price (blank = unknown)"><input type="number" min="0" step="0.0001" value={option.pricePerPurchaseUnit} onChange={(event) => changeOption(option.id, "pricePerPurchaseUnit", event.target.value)} className={inputClass} /></Field>
          {linkedCatalog && <p className="sm:col-span-3 text-sm text-gray-600">{packageConversionLabel(option.baseUnitsPerPurchaseUnit, form.baseUnit, linkedCatalog.baseUnit)}</p>}
          <button type="button" onClick={() => change("purchaseOptions", form.purchaseOptions.filter((candidate) => candidate.id !== option.id))} className="text-sm text-red-700 text-left">Remove purchase option</button>
        </div>)}
        <button type="button" disabled={form.purchaseOptions.length >= 20} onClick={() => change("purchaseOptions", [...form.purchaseOptions, { id: crypto.randomUUID(), purchaseUnit: "", baseUnitsPerPurchaseUnit: "", pricePerPurchaseUnit: "" }])} className="rounded border px-3 py-2 text-sm">Add purchase option</button>
      </div>
      <Field title="Image URL" wide><input value={form.imageUrl} onChange={(event) => change("imageUrl", event.target.value)} className={inputClass} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={(event) => change("active", event.target.checked)} /> Active</label>
    </fieldset>
    <button type="submit" disabled={saving || sources.loading || Boolean(sources.error)} className="rounded bg-brand-800 px-4 py-2 font-semibold text-white disabled:opacity-60">{saving ? savingLabel : submitLabel}</button>
  </form>;
}
