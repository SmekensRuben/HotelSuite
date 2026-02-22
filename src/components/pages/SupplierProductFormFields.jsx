import React, { useEffect, useMemo, useState } from "react";

const defaultVariant = {
  perBaseUnit: "",
  packages: "",
};

const defaultState = {
  supplierId: "",
  supplierSku: "",
  nameAtSupplier: "",
  currency: "EUR",
  pricingModel: "Per Purchase Unit",
  pricePerBaseUnit: "",
  pricePerPurchaseUnit: "",
  purchaseUnit: "",
  baseUnit: "",
  baseUnitsPerPurchaseUnit: "",
  catalogProductId: "",
  active: true,
  hasVariants: false,
  variants: [defaultVariant],
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
    purchaseUnit: initialData.purchaseUnit || "",
    variants:
      Array.isArray(initialData.variants) && initialData.variants.length > 0
        ? initialData.variants.map((variant) => ({
            perBaseUnit:
              variant?.perBaseUnit !== undefined && variant?.perBaseUnit !== null
                ? String(variant.perBaseUnit)
                : "",
            packages:
              variant?.packages !== undefined && variant?.packages !== null
                ? String(variant.packages)
                : "",
          }))
        : [defaultVariant],
  };
}


function roundToTwo(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function formatTwoDecimals(value) {
  if (value === null || value === undefined || value === "") return "";
  return roundToTwo(value).toFixed(2);
}

function SectionCard({ title, children }) {
  return (
    <div className="sm:col-span-2 rounded-xl border border-gray-200 bg-gray-50/70 p-4">
      <h2 className="text-base font-semibold text-gray-900 mb-3">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </div>
  );
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

  const updateVariant = (index, key, value) => {
    setFormState((prev) => ({
      ...prev,
      variants: prev.variants.map((variant, i) => (i === index ? { ...variant, [key]: value } : variant)),
    }));
  };

  const addVariant = () => {
    setFormState((prev) => ({ ...prev, variants: [...prev.variants, defaultVariant] }));
  };

  const removeVariant = (index) => {
    setFormState((prev) => ({
      ...prev,
      variants: prev.variants.length === 1 ? [defaultVariant] : prev.variants.filter((_, i) => i !== index),
    }));
  };

  const computedVariants = useMemo(() => {
    return formState.variants
      .map((variant) => {
        const perBaseUnit = Number(variant.perBaseUnit) || 0;
        const packages = Number(variant.packages) || 0;
        const baseUnitsPerPurchaseUnit = roundToTwo(perBaseUnit * packages);
        const pricePerPurchaseUnit = roundToTwo((Number(formState.pricePerBaseUnit) || 0) * baseUnitsPerPurchaseUnit);

        return {
          perBaseUnit,
          packages,
          baseUnitsPerPurchaseUnit,
          pricePerPurchaseUnit,
          isComplete: perBaseUnit > 0 && packages > 0,
        };
      });
  }, [formState.variants, formState.pricePerBaseUnit]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);

    const isPerPurchaseUnit = formState.pricingModel === "Per Purchase Unit";
    const completedVariants = computedVariants.filter((variant) => variant.isComplete);
    const firstComputedVariant = completedVariants[0] || null;

    const payload = {
      supplierId: formState.supplierId.trim(),
      supplierSku: formState.supplierSku.trim(),
      nameAtSupplier: formState.nameAtSupplier.trim(),
      currency: formState.currency.trim() || "EUR",
      pricingModel: formState.pricingModel,
      purchaseUnit: formState.pricingModel === "Per Purchase Unit" ? formState.purchaseUnit.trim() : "",
      baseUnit: formState.baseUnit.trim(),
      catalogProductId: formState.catalogProductId.trim(),
      active: formState.active,
      hasVariants: formState.hasVariants,
      pricePerBaseUnit: formState.hasVariants
        ? Number(formState.pricePerBaseUnit) || 0
        : isPerPurchaseUnit
          ? null
          : Number(formState.pricePerBaseUnit) || 0,
      pricePerPurchaseUnit: formState.hasVariants
        ? firstComputedVariant?.pricePerPurchaseUnit || 0
        : isPerPurchaseUnit
          ? Number(formState.pricePerPurchaseUnit) || 0
          : null,
      baseUnitsPerPurchaseUnit: formState.hasVariants
        ? firstComputedVariant?.baseUnitsPerPurchaseUnit || 0
        : isPerPurchaseUnit
          ? Number(formState.baseUnitsPerPurchaseUnit) || 0
          : null,
      priceUpdatedOn: new Date().toISOString(),
      variants: formState.hasVariants
        ? completedVariants.map((variant) => ({
            perBaseUnit: variant.perBaseUnit,
            packages: variant.packages,
            baseUnitsPerPurchaseUnit: variant.baseUnitsPerPurchaseUnit,
            pricePerPurchaseUnit: variant.pricePerPurchaseUnit,
          }))
        : [],
    };

    await onSubmit(payload);
    setSaving(false);
  };

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
      <SectionCard title="Identity">
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
      </SectionCard>

      <SectionCard title="Pricing">
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
            onChange={(event) => {
              const nextPricingModel = event.target.value;
              setFormState((prev) => ({
                ...prev,
                pricingModel: nextPricingModel,
                hasVariants: nextPricingModel === "Per Base Unit" ? prev.hasVariants : false,
              }));
            }}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="Per Purchase Unit">Per Purchase Unit</option>
            <option value="Per Base Unit">Per Base Unit</option>
          </select>
        </label>

        {formState.pricingModel !== "Per Purchase Unit" && (
          <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
            Base Unit
            <input
              value={formState.baseUnit}
              onChange={(event) => updateField("baseUnit", event.target.value)}
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        )}


        {formState.pricingModel === "Per Base Unit" && (
          <label className="flex items-center gap-2 text-sm font-semibold text-gray-700 sm:col-span-2">
            <input
              type="checkbox"
              checked={formState.hasVariants}
              onChange={(event) => updateField("hasVariants", event.target.checked)}
            />
            Has Variants
          </label>
        )}

        {formState.pricingModel === "Per Base Unit" && formState.hasVariants ? (
          <>
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
            <div className="sm:col-span-2 space-y-3">
              {formState.variants.map((variant, index) => {
                const computed = computedVariants[index] || {
                  baseUnitsPerPurchaseUnit: 0,
                  pricePerPurchaseUnit: 0,
                };
                return (
                  <div key={index} className="grid gap-3 sm:grid-cols-2 border border-gray-200 rounded-lg p-3 bg-white">
                    <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
                      Weight (perBaseUnit) *
                      <input
                        required
                        type="number"
                        step="0.0001"
                        min="0"
                        value={variant.perBaseUnit}
                        onChange={(event) => updateVariant(index, "perBaseUnit", event.target.value)}
                        className="rounded border border-gray-300 px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
                      Packages (pieces per weight) *
                      <input
                        required
                        type="number"
                        step="1"
                        min="0"
                        value={variant.packages}
                        onChange={(event) => updateVariant(index, "packages", event.target.value)}
                        className="rounded border border-gray-300 px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
                      Base Units Per Purchase Unit (calculated)
                      <input
                        readOnly
                        value={formatTwoDecimals(computed.baseUnitsPerPurchaseUnit)}
                        className="rounded border border-gray-200 bg-gray-100 px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
                      Price Per Purchase Unit (calculated)
                      <input
                        readOnly
                        value={formatTwoDecimals(computed.pricePerPurchaseUnit)}
                        className="rounded border border-gray-200 bg-gray-100 px-3 py-2 text-sm"
                      />
                    </label>
                    <div className="sm:col-span-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => removeVariant(index)}
                        className="text-sm font-semibold text-red-700 hover:text-red-900"
                      >
                        Remove variant
                      </button>
                    </div>
                  </div>
                );
              })}
              <button
                type="button"
                onClick={addVariant}
                className="px-3 py-2 rounded border border-gray-300 text-sm font-semibold text-gray-700 hover:bg-gray-100"
              >
                Add variant
              </button>
            </div>
          </>
        ) : formState.pricingModel === "Per Purchase Unit" ? (
          <>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
              Purchase Unit *
              <input
                required
                value={formState.purchaseUnit}
                onChange={(event) => updateField("purchaseUnit", event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
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
              Base Unit *
              <input
                required
                value={formState.baseUnit}
                onChange={(event) => updateField("baseUnit", event.target.value)}
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
      </SectionCard>

      <SectionCard title="Linking & Metadata">
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
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
      </SectionCard>

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
