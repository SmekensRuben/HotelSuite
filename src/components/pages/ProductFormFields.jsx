import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { uploadCatalogProductImage } from "../../services/firebaseProducts";

const defaultState = {
  name: "",
  brand: "",
  description: "",
  active: true,
  category: "",
  subcategory: "",
  baseUnit: "",
  baseQtyPerUnit: "",
  gtin: "",
  internalSku: "",
  storageType: "",
  allergens: "",
  notes: "",
  imageUrl: "",
};

function toFormState(initialData) {
  if (!initialData) return defaultState;
  return {
    ...defaultState,
    ...initialData,
    baseQtyPerUnit:
      initialData.baseQtyPerUnit !== undefined && initialData.baseQtyPerUnit !== null
        ? String(initialData.baseQtyPerUnit)
        : "",
    allergens: Array.isArray(initialData.allergens)
      ? initialData.allergens.join(", ")
      : initialData.allergens || "",
  };
}

function SectionCard({ title, children }) {
  return (
    <div className="sm:col-span-2 rounded-xl border border-gray-200 bg-gray-50/70 p-4">
      <h2 className="text-base font-semibold text-gray-900 mb-3">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </div>
  );
}

export default function ProductFormFields({
  hotelUid,
  initialData,
  onSubmit,
  savingLabel,
  submitLabel,
  showImagePreview = true,
}) {
  const { t } = useTranslation("common");
  const [formState, setFormState] = useState(() => toFormState(initialData));
  const [saving, setSaving] = useState(false);
  const [imageFile, setImageFile] = useState(null);

  useEffect(() => {
    setFormState(toFormState(initialData));
    setImageFile(null);
  }, [initialData]);

  const previewUrl = useMemo(() => {
    if (!imageFile) return formState.imageUrl || "";
    return URL.createObjectURL(imageFile);
  }, [imageFile, formState.imageUrl]);

  useEffect(() => {
    return () => {
      if (previewUrl && imageFile) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl, imageFile]);

  const updateField = (key, value) => {
    setFormState((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!hotelUid || !formState.name.trim()) return;
    setSaving(true);

    let imageUrl = formState.imageUrl || "";
    if (imageFile) {
      imageUrl = await uploadCatalogProductImage(hotelUid, imageFile);
    }

    const payload = {
      name: formState.name.trim(),
      brand: formState.brand.trim(),
      description: formState.description.trim(),
      active: formState.active,
      category: formState.category.trim(),
      subcategory: formState.subcategory.trim(),
      baseUnit: formState.baseUnit.trim(),
      baseQtyPerUnit: Number(formState.baseQtyPerUnit) || 0,
      gtin: formState.gtin.trim(),
      internalSku: formState.internalSku.trim(),
      storageType: formState.storageType.trim(),
      allergens: formState.allergens
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      notes: formState.notes.trim(),
      imageUrl,
    };

    await onSubmit(payload);
    setSaving(false);
  };

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
      <SectionCard title={t("products.sections.identity")}>
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          {t("products.fields.name")} *
          <input
            required
            value={formState.name}
            onChange={(event) => updateField("name", event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          {t("products.fields.brand")}
          <input
            value={formState.brand}
            onChange={(event) => updateField("brand", event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700 sm:col-span-2">
          {t("products.fields.description")}
          <textarea
            value={formState.description}
            onChange={(event) => updateField("description", event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm min-h-24"
          />
        </label>
        <label className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <input
            type="checkbox"
            checked={formState.active}
            onChange={(event) => updateField("active", event.target.checked)}
          />
          {t("products.fields.active")}
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700 sm:col-span-2">
          {t("products.fields.image")}
          <input
            type="file"
            accept="image/*"
            onChange={(event) => setImageFile(event.target.files?.[0] || null)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
          {showImagePreview && previewUrl && (
            <img
              src={previewUrl}
              alt="Product preview"
              className="mt-2 h-32 w-32 rounded object-cover border border-gray-200"
            />
          )}
        </label>
      </SectionCard>

      <SectionCard title={t("products.sections.classification")}>
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          {t("products.fields.category")}
          <input
            value={formState.category}
            onChange={(event) => updateField("category", event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          {t("products.fields.subcategory")}
          <input
            value={formState.subcategory}
            onChange={(event) => updateField("subcategory", event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      </SectionCard>

      <SectionCard title={t("products.sections.units")}>
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          {t("products.fields.baseUnit")}
          <input
            value={formState.baseUnit}
            onChange={(event) => updateField("baseUnit", event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          {t("products.fields.baseQtyPerUnit")}
          <input
            type="number"
            step="0.01"
            min="0"
            value={formState.baseQtyPerUnit}
            onChange={(event) => updateField("baseQtyPerUnit", event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      </SectionCard>

      <SectionCard title={t("products.sections.identifiers")}>
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          {t("products.fields.gtin")}
          <input
            value={formState.gtin}
            onChange={(event) => updateField("gtin", event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          {t("products.fields.internalSku")}
          <input
            value={formState.internalSku}
            onChange={(event) => updateField("internalSku", event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      </SectionCard>

      <SectionCard title={t("products.sections.storage")}>
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          {t("products.fields.storageType")}
          <input
            value={formState.storageType}
            onChange={(event) => updateField("storageType", event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
          {t("products.fields.allergens")}
          <input
            value={formState.allergens}
            onChange={(event) => updateField("allergens", event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-gray-700 sm:col-span-2">
          {t("products.fields.notes")}
          <textarea
            value={formState.notes}
            onChange={(event) => updateField("notes", event.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm min-h-24"
          />
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
