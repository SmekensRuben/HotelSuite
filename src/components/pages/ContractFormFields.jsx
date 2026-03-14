import React, { useState } from "react";

const INITIAL_STATE = {
  name: "",
  startDate: "",
  endDate: "",
  terminationPeriod: "",
  category: "",
};

export default function ContractFormFields({ onSubmit, submitLabel, savingLabel }) {
  const [formState, setFormState] = useState(INITIAL_STATE);
  const [contractFile, setContractFile] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleChange = (key, value) => {
    setFormState((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!formState.name.trim()) return;

    setSaving(true);
    try {
      await onSubmit(
        {
          ...formState,
          name: formState.name.trim(),
          terminationPeriod: formState.terminationPeriod.trim(),
          category: formState.category.trim(),
        },
        contractFile
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 sm:col-span-2">
          <span className="text-sm font-medium text-gray-700">Name</span>
          <input
            type="text"
            value={formState.name}
            onChange={(event) => handleChange("name", event.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
            required
          />
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium text-gray-700">Start Date</span>
          <input
            type="date"
            value={formState.startDate}
            onChange={(event) => handleChange("startDate", event.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
          />
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium text-gray-700">End Date</span>
          <input
            type="date"
            value={formState.endDate}
            onChange={(event) => handleChange("endDate", event.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
          />
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium text-gray-700">Termination Period</span>
          <input
            type="text"
            value={formState.terminationPeriod}
            onChange={(event) => handleChange("terminationPeriod", event.target.value)}
            placeholder="e.g. 3 months"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
          />
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium text-gray-700">Category</span>
          <input
            type="text"
            value={formState.category}
            onChange={(event) => handleChange("category", event.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
          />
        </label>

        <label className="space-y-1 sm:col-span-2">
          <span className="text-sm font-medium text-gray-700">Contract File</span>
          <input
            type="file"
            onChange={(event) => setContractFile(event.target.files?.[0] || null)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[#b41f1f] file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
          />
        </label>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className={`rounded-lg px-5 py-2 text-sm font-semibold ${
            saving ? "bg-gray-300 text-gray-500" : "bg-[#b41f1f] text-white hover:bg-[#961919]"
          }`}
        >
          {saving ? savingLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}
