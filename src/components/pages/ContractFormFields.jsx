import React, { useEffect, useMemo, useState } from "react";

const INITIAL_STATE = {
  name: "",
  startDate: "",
  endDate: "",
  terminationPeriodDays: "",
  category: "",
  followers: [],
};

function sanitizeFollowers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((follower) => ({
      id: String(follower?.id || "").trim(),
      email: String(follower?.email || "").trim(),
      name: String(follower?.name || "").trim(),
    }))
    .filter((follower) => follower.id);
}

export default function ContractFormFields({
  onSubmit,
  submitLabel,
  savingLabel,
  initialValues,
  availableUsers = [],
}) {
  const [formState, setFormState] = useState(INITIAL_STATE);
  const [contractFile, setContractFile] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!initialValues) {
      setFormState(INITIAL_STATE);
      return;
    }

    setFormState({
      name: String(initialValues.name || ""),
      startDate: String(initialValues.startDate || ""),
      endDate: String(initialValues.endDate || ""),
      terminationPeriodDays:
        initialValues.terminationPeriodDays === 0 || initialValues.terminationPeriodDays
          ? String(initialValues.terminationPeriodDays)
          : "",
      category: String(initialValues.category || ""),
      followers: sanitizeFollowers(initialValues.followers),
    });
  }, [initialValues]);

  const selectedFollowerIds = useMemo(
    () => new Set(formState.followers.map((follower) => follower.id)),
    [formState.followers]
  );

  const handleChange = (key, value) => {
    setFormState((prev) => ({ ...prev, [key]: value }));
  };

  const toggleFollower = (user, checked) => {
    setFormState((prev) => {
      if (checked) {
        const nextFollowers = [
          ...prev.followers,
          {
            id: user.id,
            email: String(user.email || "").trim(),
            name: `${String(user.firstName || "").trim()} ${String(user.lastName || "").trim()}`.trim(),
          },
        ];
        return { ...prev, followers: nextFollowers.filter((follower, index, self) => self.findIndex((x) => x.id === follower.id) === index) };
      }

      return {
        ...prev,
        followers: prev.followers.filter((follower) => follower.id !== user.id),
      };
    });
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
          terminationPeriodDays: Number(formState.terminationPeriodDays || 0),
          category: formState.category.trim(),
          followers: sanitizeFollowers(formState.followers),
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
          <span className="text-sm font-medium text-gray-700">Termination Period (days)</span>
          <input
            type="number"
            min="0"
            step="1"
            value={formState.terminationPeriodDays}
            onChange={(event) => handleChange("terminationPeriodDays", event.target.value)}
            placeholder="e.g. 30"
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

      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-700">Followers</p>
        {availableUsers.length === 0 ? (
          <p className="text-sm text-gray-500">No users available.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {availableUsers.map((user) => {
              const label = `${String(user.firstName || "").trim()} ${String(user.lastName || "").trim()}`.trim() || user.email || user.id;
              return (
                <label key={user.id} className="flex items-center gap-2 rounded border border-gray-200 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selectedFollowerIds.has(user.id)}
                    onChange={(event) => toggleFollower(user, event.target.checked)}
                    className="h-4 w-4"
                  />
                  <span className="text-sm text-gray-700">{label} ({user.email || "no-email"})</span>
                </label>
              );
            })}
          </div>
        )}
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
