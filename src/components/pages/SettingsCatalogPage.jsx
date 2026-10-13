import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "../layout/Card";
import { useProcurementSettingsScope } from "../../hooks/useProcurementSettingsScope";
import {
  getCatalogTaxonomy,
  createCatalogCategory,
  updateCatalogCategory,
  deleteCatalogCategory,
  createCatalogSubcategory,
  updateCatalogSubcategory,
  deleteCatalogSubcategory,
} from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";
import { Combobox } from "../ui/combobox";

function sortByName(items) {
  return [...items].sort((firstItem, secondItem) =>
    firstItem.name.localeCompare(secondItem.name, undefined, {
      sensitivity: "base",
    }),
  );
}

export default function SettingsCatalogPage() {
  const scope = useProcurementSettingsScope();
  const canRead = usePermission("catalogsettings", "read");
  return canRead ? <CatalogTaxonomySection key={scope.scopeKey} scope={scope} /> : null;
}

function CatalogTaxonomySection({ scope }) {
  const { hotelUid, current } = scope;
  const canCreateSettings = usePermission("catalogsettings", "create");
  const canUpdateSettings = usePermission("catalogsettings", "update");
  const canDeleteSettings = usePermission("catalogsettings", "delete");
  const [loading, setLoading] = useState(true);
  const [savingCategory, setSavingCategory] = useState(false);
  const [savingSubcategory, setSavingSubcategory] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [subcategoryName, setSubcategoryName] = useState("");
  const [subcategoryCategoryId, setSubcategoryCategoryId] = useState("");
  const [categories, setCategories] = useState([]);
  const [subcategories, setSubcategories] = useState([]);
  const [editingCategoryId, setEditingCategoryId] = useState("");
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [editingSubcategoryId, setEditingSubcategoryId] = useState("");
  const [editingSubcategoryName, setEditingSubcategoryName] = useState("");
  const [editingSubcategoryCategoryId, setEditingSubcategoryCategoryId] =
    useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const sortedCategories = useMemo(() => sortByName(categories), [categories]);

  const groupedSubcategories = useMemo(() => {
    const groupedMap = sortedCategories.map((category) => ({
      category,
      subcategories: sortByName(
        subcategories.filter(
          (subcategory) => subcategory.categoryId === category.id,
        ),
      ),
    }));

    const unlinkedSubcategories = sortByName(
      subcategories.filter(
        (subcategory) =>
          !sortedCategories.some(
            (category) => category.id === subcategory.categoryId,
          ),
      ),
    );

    if (unlinkedSubcategories.length > 0) {
      groupedMap.push({
        category: { id: "unlinked", name: "Unlinked" },
        subcategories: unlinkedSubcategories,
      });
    }

    return groupedMap;
  }, [sortedCategories, subcategories]);

  useEffect(() => {
    setCategoryName("");
    setSubcategoryName("");
    setSubcategoryCategoryId("");
    setEditingCategoryId("");
    setEditingCategoryName("");
    setEditingSubcategoryId("");
    setEditingSubcategoryName("");
    setEditingSubcategoryCategoryId("");
  }, [hotelUid]);

  useEffect(() => {
    const version = ++requestVersion.current;
    setCategories([]);
    setSubcategories([]);
    setError("");
    setMessage("");
    setLoading(Boolean(hotelUid));
    setSavingCategory(false);
    setSavingSubcategory(false);
    if (!hotelUid) return;
    getCatalogTaxonomy(hotelUid)
      .then((taxonomy) => {
        if (version !== requestVersion.current || !current()) return;
        setCategories(taxonomy.categories);
        setSubcategories(taxonomy.subcategories);
      })
      .catch(() => {
        if (version === requestVersion.current && current())
          setError("Settings could not be loaded.");
      })
      .finally(() => {
        if (version === requestVersion.current && current()) setLoading(false);
      });
    return () => {
      ++requestVersion.current;
    };
  }, [hotelUid, loadAttempt]);

  const saveTaxonomy = async (mutation, successMessage) => {
    if (!current()) return false;
    const version = requestVersion.current;
    setSavingCategory(true);
    setSavingSubcategory(true);
    setError("");
    setMessage("");
    let saved = false;
    try {
      await mutation();
      saved = true;
      if (version !== requestVersion.current || !current()) return false;
      const taxonomy = await getCatalogTaxonomy(hotelUid);
      if (version !== requestVersion.current || !current()) return false;
      setCategories(taxonomy.categories);
      setSubcategories(taxonomy.subcategories);
      setMessage(successMessage);
      return true;
    } catch (error) {
      if (version === requestVersion.current && current())
        setError(
          saved
            ? "Changes saved, but settings could not be refreshed. Reload settings."
            : error.message || "Settings could not be saved.",
        );
      return version === requestVersion.current && current() && saved;
    } finally {
      if (version === requestVersion.current && current()) {
        setSavingCategory(false);
        setSavingSubcategory(false);
      }
    }
  };

  const handleAddCategory = async (event) => {
    event.preventDefault();
    const name = categoryName.trim();
    if (!canCreateSettings || !hotelUid || !name || savingCategory) return;
    if (
      await saveTaxonomy(
        () => createCatalogCategory(hotelUid, { name }),
        "Category created.",
      )
    )
      setCategoryName("");
  };

  const handleAddSubcategory = async (event) => {
    event.preventDefault();
    const name = subcategoryName.trim();
    if (!canCreateSettings || !hotelUid || savingSubcategory) return;
    if (!name || !subcategoryCategoryId) {
      setError(
        "Please select one category and enter a name for this subcategory.",
      );
      return;
    }
    if (
      await saveTaxonomy(
        () =>
          createCatalogSubcategory(hotelUid, {
            name,
            categoryId: subcategoryCategoryId,
          }),
        "Subcategory created.",
      )
    ) {
      setSubcategoryName("");
      setSubcategoryCategoryId("");
    }
  };

  const startCategoryEdit = (category) => {
    setEditingCategoryId(category.id);
    setEditingCategoryName(category.name);
  };

  const handleSaveCategoryEdit = async () => {
    const name = editingCategoryName.trim();
    if (
      !canUpdateSettings ||
      !hotelUid ||
      !editingCategoryId ||
      !name ||
      savingCategory
    )
      return;
    if (
      await saveTaxonomy(
        () => updateCatalogCategory(hotelUid, editingCategoryId, { name }),
        "Category updated.",
      )
    ) {
      setEditingCategoryId("");
      setEditingCategoryName("");
    }
  };

  const handleDeleteCategory = async (categoryId) => {
    if (!canDeleteSettings || !hotelUid || !categoryId || savingCategory)
      return;
    const hasLinkedSubcategories = subcategories.some(
      (subcategory) => subcategory.categoryId === categoryId,
    );
    if (
      !window.confirm(
        hasLinkedSubcategories
          ? "This category has linked subcategories. Deleting it will also delete those subcategories. Continue?"
          : "Delete this category?",
      )
    )
      return;
    if (
      await saveTaxonomy(
        () => deleteCatalogCategory(hotelUid, categoryId),
        "Category deleted.",
      )
    ) {
      setEditingCategoryId("");
      setEditingCategoryName("");
    }
  };

  const startSubcategoryEdit = (subcategory) => {
    setEditingSubcategoryId(subcategory.id);
    setEditingSubcategoryName(subcategory.name);
    setEditingSubcategoryCategoryId(subcategory.categoryId);
  };

  const handleSaveSubcategoryEdit = async () => {
    const name = editingSubcategoryName.trim();
    if (
      !canUpdateSettings ||
      !hotelUid ||
      !editingSubcategoryId ||
      savingSubcategory
    )
      return;
    if (!name || !editingSubcategoryCategoryId) {
      setError(
        "Each subcategory must have a name and be linked to one category.",
      );
      return;
    }
    if (
      await saveTaxonomy(
        () =>
          updateCatalogSubcategory(hotelUid, editingSubcategoryId, {
            name,
            categoryId: editingSubcategoryCategoryId,
          }),
        "Subcategory updated.",
      )
    ) {
      setEditingSubcategoryId("");
      setEditingSubcategoryName("");
      setEditingSubcategoryCategoryId("");
    }
  };

  const handleDeleteSubcategory = async (subcategoryId) => {
    if (!canDeleteSettings || !hotelUid || !subcategoryId || savingSubcategory)
      return;
    if (!window.confirm("Delete this subcategory?")) return;
    if (
      await saveTaxonomy(
        () => deleteCatalogSubcategory(hotelUid, subcategoryId),
        "Subcategory deleted.",
      )
    ) {
      setEditingSubcategoryId("");
      setEditingSubcategoryName("");
      setEditingSubcategoryCategoryId("");
    }
  };

  const categoryOptions = sortedCategories;
  const categoryPicker = (value, onChange, id, disabled = false) => (
    <Combobox
      id={id}
      value={categoryOptions.find((category) => category.id === value) || null}
      onChange={(category) => onChange(category?.id || "")}
      options={categoryOptions}
      displayValue={(category) => category.name}
      getOptionValue={(category) => category.id}
      placeholder="Search categories"
      disabled={disabled || loading}
      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
    />
  );
  const busy = savingCategory || savingSubcategory;
  const actionClass =
    "rounded-md border border-gray-200 px-2.5 py-1.5 text-xs font-medium hover:bg-gray-50 disabled:opacity-50";
  return (
    <section aria-label="Catalog categories" className="space-y-5">
        <div>
          <h2 className="text-xl font-semibold">Categories &amp; subcategories</h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">
            Organize catalog articles for browsing, ordering and stock templates.
          </p>
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {error}{" "}
            <button
              type="button"
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              className="underline"
            >
              Reload settings
            </button>
          </p>
        )}
        {message && (
          <p
            role="status"
            className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
          >
            {message}
          </p>
        )}
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          <Card className="space-y-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold">Categories</h3>
              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">
                {sortedCategories.length}
              </span>
            </div>
            <form
              onSubmit={handleAddCategory}
              className="space-y-2 rounded-xl bg-gray-50 p-3"
            >
              <label
                htmlFor="new-category"
                className="text-xs font-medium text-gray-700"
              >
                New category
              </label>
              <input
                id="new-category"
                maxLength={200}
                value={categoryName}
                disabled={!canCreateSettings || loading || busy}
                onChange={(event) => setCategoryName(event.target.value)}
                placeholder="New category"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={!canCreateSettings || loading || busy}
                className="rounded-lg bg-brand-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {savingCategory ? "Saving..." : "Add category"}
              </button>
            </form>
            {loading ? (
              <p className="text-sm text-gray-600">Loading categories...</p>
            ) : sortedCategories.length === 0 ? (
              <p className="text-sm text-gray-600">No categories yet.</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {sortedCategories.map((category) => (
                  <li key={category.id} className="space-y-2 py-3">
                    <div className="flex items-center justify-between gap-3">
                      {editingCategoryId === category.id ? (
                        <input
                          aria-label="Category name"
                          maxLength={200}
                          value={editingCategoryName}
                          onChange={(event) =>
                            setEditingCategoryName(event.target.value)
                          }
                          className="min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-sm"
                        />
                      ) : (
                        <span className="font-medium text-gray-800">
                          {category.name}
                        </span>
                      )}
                      <span className="shrink-0 text-xs text-gray-500">
                        {
                          subcategories.filter(
                            (item) => item.categoryId === category.id,
                          ).length
                        }{" "}
                        subcategories
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {editingCategoryId === category.id ? (
                        <>
                          <button
                            type="button"
                            onClick={handleSaveCategoryEdit}
                            disabled={!canUpdateSettings || busy}
                            className={actionClass}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCategoryId("");
                              setEditingCategoryName("");
                            }}
                            disabled={busy}
                            className={actionClass}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        canUpdateSettings && (
                          <button
                            type="button"
                            onClick={() => startCategoryEdit(category)}
                            disabled={busy}
                            className={actionClass}
                          >
                            Edit
                          </button>
                        )
                      )}
                      {canDeleteSettings && (
                        <button
                          type="button"
                          onClick={() => handleDeleteCategory(category.id)}
                          disabled={busy}
                          className={`${actionClass} text-red-700`}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="space-y-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold">Subcategories</h3>
              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">
                {subcategories.length}
              </span>
            </div>
            <form
              onSubmit={handleAddSubcategory}
              className="space-y-3 rounded-xl bg-gray-50 p-3"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor="new-subcategory"
                    className="text-xs font-medium text-gray-700"
                  >
                    Subcategory name
                  </label>
                  <input
                    id="new-subcategory"
                    maxLength={200}
                    value={subcategoryName}
                    disabled={!canCreateSettings || loading || busy}
                    onChange={(event) => setSubcategoryName(event.target.value)}
                    placeholder="New subcategory"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="subcategory-category"
                    className="text-xs font-medium text-gray-700"
                  >
                    Category
                  </label>
                  {categoryPicker(
                    subcategoryCategoryId,
                    setSubcategoryCategoryId,
                    "subcategory-category",
                    !canCreateSettings || busy,
                  )}
                </div>
              </div>
              <button
                type="submit"
                disabled={
                  !canCreateSettings ||
                  loading ||
                  busy ||
                  sortedCategories.length === 0
                }
                className="rounded-lg bg-brand-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {savingSubcategory ? "Saving..." : "Add subcategory"}
              </button>
            </form>
            {loading ? (
              <p className="text-sm text-gray-600">Loading subcategories...</p>
            ) : subcategories.length === 0 ? (
              <p className="text-sm text-gray-600">No subcategories yet.</p>
            ) : (
              <div className="space-y-4">
                {groupedSubcategories.map((group) => (
                  <section
                    key={group.category.id}
                    className="rounded-xl border border-gray-200 p-3"
                  >
                    <h3 className="mb-2 text-sm font-semibold text-gray-700">
                      {group.category.name}
                    </h3>
                    {group.subcategories.length === 0 ? (
                      <p className="text-xs text-gray-500">
                        No subcategories in this category.
                      </p>
                    ) : (
                      <ul className="divide-y divide-gray-100">
                        {group.subcategories.map((subcategory) => (
                          <li key={subcategory.id} className="py-2.5">
                            {editingSubcategoryId === subcategory.id ? (
                              <div className="grid gap-2 sm:grid-cols-2">
                                <input
                                  aria-label="Subcategory name"
                                  maxLength={200}
                                  value={editingSubcategoryName}
                                  onChange={(event) =>
                                    setEditingSubcategoryName(
                                      event.target.value,
                                    )
                                  }
                                  className="min-w-0 rounded-lg border px-2 py-1.5 text-sm"
                                />
                                {categoryPicker(
                                  editingSubcategoryCategoryId,
                                  setEditingSubcategoryCategoryId,
                                  `category-${subcategory.id}`,
                                  busy,
                                )}
                              </div>
                            ) : (
                              <span className="text-sm font-medium text-gray-800">
                                {subcategory.name}
                              </span>
                            )}
                            <div className="mt-2 flex flex-wrap gap-2">
                              {editingSubcategoryId === subcategory.id ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={handleSaveSubcategoryEdit}
                                    disabled={!canUpdateSettings || busy}
                                    className={actionClass}
                                  >
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingSubcategoryId("");
                                      setEditingSubcategoryName("");
                                      setEditingSubcategoryCategoryId("");
                                    }}
                                    disabled={busy}
                                    className={actionClass}
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                canUpdateSettings && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      startSubcategoryEdit(subcategory)
                                    }
                                    disabled={busy}
                                    className={actionClass}
                                  >
                                    Edit
                                  </button>
                                )
                              )}
                              {canDeleteSettings && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleDeleteSubcategory(subcategory.id)
                                  }
                                  disabled={busy}
                                  className={`${actionClass} text-red-700`}
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                ))}
              </div>
            )}
          </Card>
        </div>
    </section>
  );
}
