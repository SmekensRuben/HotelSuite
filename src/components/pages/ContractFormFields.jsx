import React, { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Combobox } from "../ui/combobox";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSettings } from "../../services/firebaseSettings";

const INITIAL_STATE = {
  name: "",
  startDate: "",
  endDate: "",
  terminationPeriodDays: "",
  category: "",
  categoryId: "",
  subcategory: "",
  subcategoryId: "",
  followers: [],
  reminderDays: [30, 15, 7],
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

function sanitizeReminderDays(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((day) => Number(day))
      .filter((day) => Number.isFinite(day) && day >= 0)
      .map((day) => Math.floor(day))
  )].sort((a, b) => b - a);
}

function getUserLabel(user) {
  const name = `${String(user?.firstName || "").trim()} ${String(user?.lastName || "").trim()}`.trim();
  return name || user?.email || user?.id || "Unknown user";
}

export default function ContractFormFields({
  onSubmit,
  submitLabel,
  savingLabel,
  initialValues,
  availableUsers = [],
}) {
  const { hotelUid } = useHotelContext();
  const [formState, setFormState] = useState(INITIAL_STATE);
  const [contractFiles, setContractFiles] = useState([]);
  const [existingContractFiles, setExistingContractFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [selectedFollower, setSelectedFollower] = useState(null);
  const [newReminderDay, setNewReminderDay] = useState("");
  const [categoryOptions, setCategoryOptions] = useState([]);
  const [subcategoryOptions, setSubcategoryOptions] = useState([]);

  useEffect(() => {
    if (!hotelUid) return;

    const loadContractSettings = async () => {
      const settings = await getSettings(hotelUid);
      const loadedCategories = Object.entries(settings?.contractCategories || {}).map(
        ([id, value]) => ({
          id,
          name: String(value?.name || "").trim(),
        })
      );
      const validCategoryIds = new Set(loadedCategories.map((category) => category.id));
      const loadedSubcategories = Object.entries(settings?.contractSubcategories || {})
        .map(([id, value]) => ({
          id,
          name: String(value?.name || "").trim(),
          categoryId: String(value?.categoryId || "").trim(),
        }))
        .filter((subcategory) => subcategory.categoryId && validCategoryIds.has(subcategory.categoryId));

      setCategoryOptions(loadedCategories);
      setSubcategoryOptions(loadedSubcategories);
    };

    loadContractSettings();
  }, [hotelUid]);

  useEffect(() => {
    if (!initialValues) {
      setFormState(INITIAL_STATE);
      setExistingContractFiles([]);
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
      categoryId: String(initialValues.categoryId || ""),
      subcategory: String(initialValues.subcategory || ""),
      subcategoryId: String(initialValues.subcategoryId || ""),
      followers: sanitizeFollowers(initialValues.followers),
      reminderDays: sanitizeReminderDays(initialValues.reminderDays || [30, 15, 7]),
    });

    const initialContractFiles = Array.isArray(initialValues.contractFiles)
      ? initialValues.contractFiles
      : initialValues.contractFile
        ? [initialValues.contractFile]
        : [];
    setExistingContractFiles(initialContractFiles);
  }, [initialValues]);

  useEffect(() => {
    if (!categoryOptions.length) return;

    setFormState((prev) => {
      const matchedCategory = !prev.categoryId && prev.category
        ? categoryOptions.find(
            (category) => category.name.toLowerCase() === prev.category.toLowerCase()
          )
        : null;

      if (!matchedCategory) return prev;

      return {
        ...prev,
        categoryId: matchedCategory.id,
      };
    });
  }, [categoryOptions]);

  useEffect(() => {
    if (!subcategoryOptions.length) return;

    setFormState((prev) => {
      const matchedSubcategory = !prev.subcategoryId && prev.subcategory
        ? subcategoryOptions.find(
            (subcategory) =>
              subcategory.name.toLowerCase() === prev.subcategory.toLowerCase() &&
              (!prev.categoryId || subcategory.categoryId === prev.categoryId)
          )
        : null;

      if (!matchedSubcategory) return prev;

      return {
        ...prev,
        subcategoryId: matchedSubcategory.id,
      };
    });
  }, [subcategoryOptions]);

  const selectedFollowerIds = useMemo(
    () => new Set(formState.followers.map((follower) => follower.id)),
    [formState.followers]
  );

  const availableFollowerOptions = useMemo(
    () => availableUsers.filter((user) => !selectedFollowerIds.has(user.id)),
    [availableUsers, selectedFollowerIds]
  );

  const handleChange = (key, value) => {
    setFormState((prev) => ({ ...prev, [key]: value }));
  };

  const availableSubcategoryOptions = useMemo(
    () =>
      formState.categoryId
        ? subcategoryOptions.filter((subcategory) => subcategory.categoryId === formState.categoryId)
        : [],
    [subcategoryOptions, formState.categoryId]
  );

  const addFollower = () => {
    if (!selectedFollower) return;

    const follower = {
      id: String(selectedFollower.id || "").trim(),
      email: String(selectedFollower.email || "").trim(),
      name: getUserLabel(selectedFollower),
    };

    if (!follower.id) return;

    setFormState((prev) => ({
      ...prev,
      followers: sanitizeFollowers([...prev.followers, follower]),
    }));
    setSelectedFollower(null);
  };

  const removeFollower = (followerId) => {
    setFormState((prev) => ({
      ...prev,
      followers: prev.followers.filter((follower) => follower.id !== followerId),
    }));
  };

  const addReminderDay = () => {
    const parsed = Number(newReminderDay);
    if (!Number.isFinite(parsed) || parsed < 0) return;

    setFormState((prev) => ({
      ...prev,
      reminderDays: sanitizeReminderDays([...prev.reminderDays, parsed]),
    }));
    setNewReminderDay("");
  };

  const removeReminderDay = (dayToRemove) => {
    setFormState((prev) => ({
      ...prev,
      reminderDays: prev.reminderDays.filter((day) => day !== dayToRemove),
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!formState.name.trim() || !formState.categoryId || !formState.subcategoryId) return;

    setSaving(true);
    try {
      const selectedCategory = categoryOptions.find((category) => category.id === formState.categoryId);
      const selectedSubcategory = availableSubcategoryOptions.find(
        (subcategory) => subcategory.id === formState.subcategoryId
      );

      await onSubmit(
        {
          ...formState,
          name: formState.name.trim(),
          terminationPeriodDays: Number(formState.terminationPeriodDays || 0),
          category: selectedCategory?.name || "",
          categoryId: selectedCategory?.id || "",
          subcategory: selectedSubcategory?.name || "",
          subcategoryId: selectedSubcategory?.id || "",
          followers: sanitizeFollowers(formState.followers),
          reminderDays: sanitizeReminderDays(formState.reminderDays),
        },
        contractFiles,
        existingContractFiles
      );
    } finally {
      setSaving(false);
    }
  };

  const removeExistingContractFile = (fileToRemove) => {
    setExistingContractFiles((prev) =>
      prev.filter((file) => {
        const samePath = file?.filePath && file?.filePath === fileToRemove?.filePath;
        const sameUrl = file?.downloadUrl && file?.downloadUrl === fileToRemove?.downloadUrl;
        return !(samePath || sameUrl);
      })
    );
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
          <select
            value={formState.categoryId}
            onChange={(event) => {
              const nextCategoryId = event.target.value;
              setFormState((prev) => ({
                ...prev,
                categoryId: nextCategoryId,
                subcategoryId: "",
              }));
            }}
            required
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20"
          >
            <option value="">Select category</option>
            {categoryOptions.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium text-gray-700">Subcategory</span>
          <select
            value={formState.subcategoryId}
            onChange={(event) => handleChange("subcategoryId", event.target.value)}
            disabled={!formState.categoryId || availableSubcategoryOptions.length === 0}
            required
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#b41f1f]/20 disabled:bg-gray-100"
          >
            <option value="">Select subcategory</option>
            {availableSubcategoryOptions.map((subcategory) => (
              <option key={subcategory.id} value={subcategory.id}>
                {subcategory.name}
              </option>
            ))}
          </select>
          {formState.categoryId && availableSubcategoryOptions.length === 0 && (
            <p className="text-xs text-gray-500">
              No subcategories found for this category. Add one in contract settings first.
            </p>
          )}
        </label>

        <label className="space-y-1 sm:col-span-2">
          <span className="text-sm font-medium text-gray-700">Contract Documents</span>
          <input
            type="file"
            multiple
            onChange={(event) => setContractFiles(Array.from(event.target.files || []))}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[#b41f1f] file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
          />
          {contractFiles.length > 0 && (
            <p className="mt-2 text-xs text-gray-500">
              {contractFiles.length} file(s) selected: {contractFiles.map((file) => file.name).join(", ")}
            </p>
          )}

          {existingContractFiles.length > 0 && (
            <div className="mt-3 space-y-2">
              <p className="text-xs font-medium text-gray-600">Existing documents</p>
              <ul className="space-y-2">
                {existingContractFiles.map((file, index) => (
                  <li
                    key={`${file.filePath || file.downloadUrl || file.fileName}-${index}`}
                    className="flex items-center justify-between rounded border border-gray-200 px-3 py-2 text-sm"
                  >
                    <span className="truncate pr-2">{file.fileName || `Document ${index + 1}`}</span>
                    <button
                      type="button"
                      onClick={() => removeExistingContractFile(file)}
                      className="rounded p-1 text-red-600 hover:bg-red-50"
                      title="Remove document"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-700">Followers</p>
        <div className="flex gap-2">
          <div className="flex-1">
            <Combobox
              value={selectedFollower}
              onChange={setSelectedFollower}
              options={availableFollowerOptions}
              displayValue={(user) => `${getUserLabel(user)} (${user.email || "no-email"})`}
              getOptionValue={(user) => user.id}
              placeholder="Search and select a user"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={addFollower}
            disabled={!selectedFollower}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ${
              selectedFollower
                ? "bg-[#b41f1f] text-white hover:bg-[#961919]"
                : "bg-gray-300 text-gray-500"
            }`}
          >
            Add
          </button>
        </div>

        {formState.followers.length === 0 ? (
          <p className="text-sm text-gray-500">No followers selected.</p>
        ) : (
          <ul className="space-y-2">
            {formState.followers.map((follower) => (
              <li
                key={follower.id}
                className="flex items-center justify-between rounded border border-gray-200 px-3 py-2 text-sm"
              >
                <span>
                  {follower.name || follower.email || follower.id} ({follower.email || "no-email"})
                </span>
                <button
                  type="button"
                  onClick={() => removeFollower(follower.id)}
                  className="rounded p-1 text-red-600 hover:bg-red-50"
                  title="Remove follower"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-700">Reminder days</p>
        <div className="flex gap-2">
          <input
            type="number"
            min="0"
            step="1"
            value={newReminderDay}
            onChange={(event) => setNewReminderDay(event.target.value)}
            placeholder="e.g. 14"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={addReminderDay}
            className="rounded-lg bg-[#b41f1f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#961919]"
          >
            Add day
          </button>
        </div>

        {formState.reminderDays.length === 0 ? (
          <p className="text-sm text-gray-500">No reminder days selected.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {formState.reminderDays.map((day) => (
              <li key={day} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-sm">
                {day}d
                <button
                  type="button"
                  onClick={() => removeReminderDay(day)}
                  className="rounded p-0.5 text-red-600 hover:bg-red-100"
                  title="Remove reminder day"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
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
