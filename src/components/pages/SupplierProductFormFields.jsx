import React, { useEffect, useState } from "react";

const defaultState = {
  supplierId: "",
  supplierSku: "",
  nameAtSupplier: "",
  currency: "EUR",
  pricingModel: "Per Purchase Unit",
  pricePerBaseUnit: "",
  pricePerPurchaseUnit: "",
  baseUnit: "",
  baseUnitsPerPurchaseUnit: "",
  catalogProductId: "",
  active: true,
  hasVariants: false,
};

function toFormState(initialData) {
  if (!initialData) return defaultState;
  return {
    ...defaultState,
    ...initialData,
    pricePerBaseUnit:
      initialData.pricePerBaseUnit !== undefined && initialData.pricePerBaseUnit !== null
        ? String(initialData.pricePerBaseUnit)
        : "",
    pricePerPurchaseUnit:
      initialData.pricePerPurchaseUnit !== undefined && initialData.pricePerPurchaseUnit !== null
        ? String(initialData.pricePerPurchaseUnit)
        : "",
    baseUnitsPerPurchaseUnit:
      initialData.baseUnitsPerPurchaseUnit !== undefined && initialData.baseUnitsPerPurchaseUnit !== null
        ? String(initialData.baseUnitsPerPurchaseUnit)
        : "",
  };
}

export default function SupplierProductFormFields({ initialData, onSubmit, savingLabel, submitLabel }) {
  const [formState, setFormState] = useState(() => toFormState(initialData));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setFormState(toFormState(initialData));
  }, [initialData]);

  const updateField = (key, value) => {
    setFormState((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);

    const isPerPurchaseUnit = formState.pricingModel === "Per Purchase Unit";

    const payload = {
      supplierId: formState.supplierId.trim(),
      supplierSku: formState.supplierSku.trim(),
      nameAtSupplier: formState.nameAtSupplier.trim(),
      currency: formState.currency.trim() || "EUR",
      pricingModel: formState.pricingModel,
      baseUnit: formState.baseUnit.trim(),
      catalogProductId: formState.catalogProductId.trim(),
      active: formState.active,
      hasVariants: formState.hasVariants,
      pricePerBaseUnit: isPerPurchaseUnit ? null : Number(formState.pricePerBaseUnit) || 0,
      pricePerPurchaseUnit: isPerPurchaseUnit ? Number(formState.pricePerPurchaseUnit) || 0 : null,
      baseUnitsPerPurchaseUnit: isPerPurchaseUnit
        ? Number(formState.baseUnitsPerPurchaseUnit) || 0
        : null,
    };

    await onSubmit(payload);
    setSaving(false);
  };

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
        Supplier ID *
        <input
          required
          value={formState.supplierId}
          onChange={(event) => updateField("supplierId", event.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
        Supplier SKU *
        <input
          required
          value={formState.supplierSku}
          onChange={(event) => updateField("supplierSku", event.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700 sm:col-span-2">
        Name at Supplier *
        <input
          required
          value={formState.nameAtSupplier}
          onChange={(event) => updateField("nameAtSupplier", event.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
        Currency
        <input
          value={formState.currency}
          onChange={(event) => updateField("currency", event.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
        Pricing Model
        <select
          value={formState.pricingModel}
          onChange={(event) => updateField("pricingModel", event.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="Per Purchase Unit">Per Purchase Unit</option>
          <option value="Per Base Unit">Per Base Unit</option>
        </select>
      </label>

      {formState.pricingModel === "Per Purchase Unit" ? (
        <>
          <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
            Price Per Purchase Unit *
            <input
              required
              type="number"
              step="0.0001"
              min="0"
              value={formState.pricePerPurchaseUnit}
              onChange={(event) => updateField("pricePerPurchaseUnit", event.target.value)}
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
            Base Units Per Purchase Unit *
            <input
              required
              type="number"
              step="0.0001"
              min="0"
              value={formState.baseUnitsPerPurchaseUnit}
              onChange={(event) => updateField("baseUnitsPerPurchaseUnit", event.target.value)}
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </>
      ) : (
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          Price Per Base Unit *
          <input
            required
            type="number"
            step="0.0001"
            min="0"
            value={formState.pricePerBaseUnit}
            onChange={(event) => updateField("pricePerBaseUnit", event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      )}

      <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
        Base Unit
        <input
          value={formState.baseUnit}
          onChange={(event) => updateField("baseUnit", event.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700 sm:col-span-2">
        Catalog Product ID
        <input
          value={formState.catalogProductId}
          onChange={(event) => updateField("catalogProductId", event.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm"
        />
      </label>

      <label className="flex items-center gap-2 text-sm font-semibold text-gray-700">
        <input
          type="checkbox"
          checked={formState.active}
          onChange={(event) => updateField("active", event.target.checked)}
        />
        Active
      </label>

      <label className="flex items-center gap-2 text-sm font-semibold text-gray-700">
        <input
          type="checkbox"
          checked={formState.hasVariants}
          onChange={(event) => updateField("hasVariants", event.target.checked)}
        />
        Has Variants
      </label>

      <div className="sm:col-span-2 flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={saving}
          className="bg-[#b41f1f] text-white px-4 py-2 rounded font-semibold shadow hover:bg-[#961919] transition-colors disabled:opacity-60"
        >
          {saving ? savingLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}
