import React, { useMemo, useState } from "react";

const ORDER_SYSTEM_OPTIONS = ["Email", "SFTP csv"];

const EMPTY_FORM = {
  name: "",
  accountNumber: "",
  orderEmail: "",
  phone: "",
  notes: "",
  orderSystem: "Email",
  category: "",
  subcategory: "",
  webshopUrl: "",
  username: "",
  password: "",
};

export default function SupplierFormFields({
  initialValues,
  onSubmit,
  submitLabel = "Save",
  savingLabel = "Saving...",
}) {
  const baseValues = useMemo(
    () => ({ ...EMPTY_FORM, ...(initialValues || {}) }),
    [initialValues]
  );

  const [formValues, setFormValues] = useState(baseValues);
  const [saving, setSaving] = useState(false);

  const setValue = (fieldName, fieldValue) => {
    setFormValues((currentValues) => ({
      ...currentValues,
      [fieldName]: fieldValue,
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (saving) return;

    setSaving(true);
    const payload = Object.entries(formValues).reduce((accumulator, [key, value]) => {
      accumulator[key] = typeof value === "string" ? value.trim() : value;
      return accumulator;
    }, {});

    await onSubmit(payload);
    setSaving(false);
  };

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">General</h2>
          <p className="text-sm text-gray-600">Basic information and contact details.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <InputField label="Name" value={formValues.name} onChange={(value) => setValue("name", value)} required />
          <InputField
            label="Account Number"
            value={formValues.accountNumber}
            onChange={(value) => setValue("accountNumber", value)}
          />
          <InputField
            label="Order Email"
            type="email"
            value={formValues.orderEmail}
            onChange={(value) => setValue("orderEmail", value)}
          />
          <InputField label="Phone" value={formValues.phone} onChange={(value) => setValue("phone", value)} />
        </div>
        <TextAreaField label="Notes" value={formValues.notes} onChange={(value) => setValue("notes", value)} />
      </section>

      <section className="space-y-4 border-t border-gray-200 pt-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Order settings</h2>
          <p className="text-sm text-gray-600">How orders should be sent.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <SelectField
            label="Order System"
            value={formValues.orderSystem}
            options={ORDER_SYSTEM_OPTIONS}
            onChange={(value) => setValue("orderSystem", value)}
          />
        </div>
      </section>

      <section className="space-y-4 border-t border-gray-200 pt-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Classification</h2>
          <p className="text-sm text-gray-600">Category mapping for this supplier.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <InputField label="Category" value={formValues.category} onChange={(value) => setValue("category", value)} />
          <InputField
            label="Subcategory"
            value={formValues.subcategory}
            onChange={(value) => setValue("subcategory", value)}
          />
        </div>
      </section>

      <section className="space-y-4 border-t border-gray-200 pt-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Webshop access</h2>
          <p className="text-sm text-gray-600">Optional credentials for external supplier portals.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <InputField
            label="Webshop URL"
            value={formValues.webshopUrl}
            onChange={(value) => setValue("webshopUrl", value)}
            placeholder="https://"
          />
          <InputField label="Username" value={formValues.username} onChange={(value) => setValue("username", value)} />
          <InputField
            label="Password"
            type="password"
            value={formValues.password}
            onChange={(value) => setValue("password", value)}
          />
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className={`inline-flex items-center rounded-lg px-5 py-2 text-sm font-semibold text-white ${
            saving ? "bg-gray-400 cursor-not-allowed" : "bg-[#b41f1f] hover:bg-[#961919]"
          }`}
        >
          {saving ? savingLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}

function InputField({ label, value, onChange, type = "text", placeholder = "", required = false }) {
  return (
    <label className="space-y-1 block">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <input
        type={type}
        value={value || ""}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        placeholder={placeholder}
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
      />
    </label>
  );
}

function TextAreaField({ label, value, onChange }) {
  return (
    <label className="space-y-1 block">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <textarea
        rows={4}
        value={value || ""}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
      />
    </label>
  );
}

function SelectField({ label, value, options, onChange }) {
  return (
    <label className="space-y-1 block">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
