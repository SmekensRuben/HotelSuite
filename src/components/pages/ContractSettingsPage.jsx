import React, { useEffect, useMemo, useRef, useState } from "react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import {
  getContractTaxonomy, createContractCategory, updateContractCategory, deleteContractCategory,
  createContractSubcategory, updateContractSubcategory, deleteContractSubcategory,
} from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";

function sortByName(items) {
  return [...items].sort((firstItem, secondItem) =>
    firstItem.name.localeCompare(secondItem.name, undefined, { sensitivity: "base" })
  );
}

export default function ContractSettingsPage() {
  const { hotelUid } = useHotelContext();
  const canManageSettings = usePermission("contracts", "settings");
  const canCreateSettings = canManageSettings;
  const canUpdateSettings = canManageSettings;
  const canDeleteSettings = canManageSettings;
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
  const [editingSubcategoryCategoryId, setEditingSubcategoryCategoryId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const todayLabel = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    []
  );

  const sortedCategories = useMemo(() => sortByName(categories), [categories]);

  const groupedSubcategories = useMemo(
    () =>
      sortedCategories.map((category) => ({
        category,
        subcategories: sortByName(
          subcategories.filter((subcategory) => subcategory.categoryId === category.id)
        ),
      })),
    [sortedCategories, subcategories]
  );

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

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
    getContractTaxonomy(hotelUid).then((taxonomy) => {
      if (version !== requestVersion.current) return;
      setCategories(taxonomy.categories);
      setSubcategories(taxonomy.subcategories);
    }).catch(() => {
      if (version === requestVersion.current) setError("Settings could not be loaded.");
    }).finally(() => {
      if (version === requestVersion.current) setLoading(false);
    });
    return () => { ++requestVersion.current; };
  }, [hotelUid, loadAttempt]);

  const saveTaxonomy = async (mutation, successMessage) => {
    const version = requestVersion.current;
    setSavingCategory(true);
    setSavingSubcategory(true);
    setError("");
    setMessage("");
    let saved = false;
    try {
      await mutation();
      saved = true;
      if (version !== requestVersion.current) return false;
      const taxonomy = await getContractTaxonomy(hotelUid);
      if (version !== requestVersion.current) return false;
      setCategories(taxonomy.categories);
      setSubcategories(taxonomy.subcategories);
      setMessage(successMessage);
      return true;
    } catch (error) {
      if (version === requestVersion.current) setError(saved ? "Changes saved, but settings could not be refreshed. Reload settings." : error.message || "Settings could not be saved.");
      return version === requestVersion.current && saved;
    } finally {
      if (version === requestVersion.current) {
        setSavingCategory(false);
        setSavingSubcategory(false);
      }
    }
  };

  const handleAddCategory = async (event) => {
    event.preventDefault();
    const name = categoryName.trim();
    if (!canCreateSettings || !hotelUid || !name || savingCategory) return;
    if (await saveTaxonomy(() => createContractCategory(hotelUid, { name }), "Category created.")) setCategoryName("");
  };

  const handleAddSubcategory = async (event) => {
    event.preventDefault();
    const name = subcategoryName.trim();
    if (!canCreateSettings || !hotelUid || savingSubcategory) return;
    if (!name || !subcategoryCategoryId) {
      setError("Please select one category and enter a name for this subcategory.");
      return;
    }
    if (await saveTaxonomy(() => createContractSubcategory(hotelUid, { name, categoryId: subcategoryCategoryId }), "Subcategory created.")) {
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
    if (!canUpdateSettings || !hotelUid || !editingCategoryId || !name || savingCategory) return;
    if (await saveTaxonomy(() => updateContractCategory(hotelUid, editingCategoryId, { name }), "Category updated.")) {
      setEditingCategoryId("");
      setEditingCategoryName("");
    }
  };

  const handleDeleteCategory = async (categoryId) => {
    if (!canDeleteSettings || !hotelUid || !categoryId || savingCategory) return;
    const hasLinkedSubcategories = subcategories.some((subcategory) => subcategory.categoryId === categoryId);
    if (!window.confirm(hasLinkedSubcategories
      ? "This category has linked subcategories. Deleting it will also delete those subcategories. Continue?"
      : "Delete this category?")) return;
    if (await saveTaxonomy(() => deleteContractCategory(hotelUid, categoryId), "Category deleted.")) {
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
    if (!canUpdateSettings || !hotelUid || !editingSubcategoryId || savingSubcategory) return;
    if (!name || !editingSubcategoryCategoryId) {
      setError("Each subcategory must have a name and be linked to one category.");
      return;
    }
    if (await saveTaxonomy(() => updateContractSubcategory(hotelUid, editingSubcategoryId, { name, categoryId: editingSubcategoryCategoryId }), "Subcategory updated.")) {
      setEditingSubcategoryId("");
      setEditingSubcategoryName("");
      setEditingSubcategoryCategoryId("");
    }
  };

  const handleDeleteSubcategory = async (subcategoryId) => {
    if (!canDeleteSettings || !hotelUid || !subcategoryId || savingSubcategory) return;
    if (!window.confirm("Delete this subcategory?")) return;
    if (await saveTaxonomy(() => deleteContractSubcategory(hotelUid, subcategoryId), "Subcategory deleted.")) {
      setEditingSubcategoryId("");
      setEditingSubcategoryName("");
      setEditingSubcategoryCategoryId("");
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <HeaderBar today={todayLabel} onLogout={handleLogout} />
      <PageContainer className="space-y-6">
        <div>
          <p className="text-sm text-gray-500 uppercase tracking-wide">Settings</p>
          <h1 className="text-3xl font-semibold">Contract Categories</h1>
          <p className="mt-1 text-gray-600">Manage contract categories and linked subcategories.</p>
        </div>

        <Card>
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Categories</h2>
            <form onSubmit={handleAddCategory} className="flex flex-col gap-3 sm:flex-row">
              <input
                type="text"
                maxLength={200}
                value={categoryName}
                onChange={(event) => setCategoryName(event.target.value)}
                placeholder="New category"
                className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={!canCreateSettings || savingCategory}
                className="rounded bg-[#b41f1f] px-4 py-2 font-semibold text-white shadow transition-colors hover:bg-[#961919] disabled:opacity-60"
              >
                {savingCategory ? "Adding..." : "Add category"}
              </button>
            </form>

            {loading ? (
              <p className="text-gray-600">Loading data...</p>
            ) : sortedCategories.length === 0 ? (
              <p className="text-sm text-gray-600">No categories yet.</p>
            ) : (
              <ul className="space-y-2">
                {sortedCategories.map((category) => (
                  <li
                    key={category.id}
                    className="flex flex-col gap-2 rounded border px-3 py-2 text-sm sm:flex-row sm:items-center sm:gap-3"
                  >
                    {editingCategoryId === category.id ? (
                      <input
                        type="text"
                        maxLength={200}
                        value={editingCategoryName}
                        onChange={(event) => setEditingCategoryName(event.target.value)}
                        className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                      />
                    ) : (
                      <span className="flex-1">{category.name}</span>
                    )}

                    <div className="flex items-center gap-2">
                      {editingCategoryId === category.id ? (
                        <>
                          <button
                            type="button"
                            onClick={handleSaveCategoryEdit}
                            disabled={!canUpdateSettings}
                            className="rounded bg-green-600 px-2 py-1 text-xs text-white disabled:opacity-60"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCategoryId("");
                              setEditingCategoryName("");
                            }}
                            className="rounded border px-2 py-1 text-xs"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        canUpdateSettings && (
                          <button
                            type="button"
                            onClick={() => startCategoryEdit(category)}
                            className="rounded border px-2 py-1 text-xs"
                          >
                            Edit
                          </button>
                        )
                      )}

                      {canDeleteSettings && (
                        <button
                          type="button"
                          onClick={() => handleDeleteCategory(category.id)}
                          className="rounded bg-red-600 px-2 py-1 text-xs text-white"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card>
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Subcategories</h2>
            <form onSubmit={handleAddSubcategory} className="grid gap-3 sm:grid-cols-3">
              <input
                type="text"
                maxLength={200}
                value={subcategoryName}
                onChange={(event) => setSubcategoryName(event.target.value)}
                placeholder="New subcategory"
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <select
                value={subcategoryCategoryId}
                onChange={(event) => setSubcategoryCategoryId(event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">Select category</option>
                {sortedCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={!canCreateSettings || savingSubcategory || sortedCategories.length === 0}
                className="rounded bg-[#b41f1f] px-4 py-2 font-semibold text-white shadow transition-colors hover:bg-[#961919] disabled:opacity-60"
              >
                {savingSubcategory ? "Adding..." : "Add subcategory"}
              </button>
            </form>

            {loading ? (
              <p className="text-gray-600">Loading data...</p>
            ) : subcategories.length === 0 ? (
              <p className="text-sm text-gray-600">No subcategories yet.</p>
            ) : (
              <div className="space-y-4">
                {groupedSubcategories.map((group) => (
                  <div key={group.category.id} className="space-y-2">
                    <h3 className="text-sm font-semibold text-gray-700">{group.category.name}</h3>
                    {group.subcategories.length === 0 ? (
                      <p className="text-xs text-gray-500">No subcategories in this category.</p>
                    ) : (
                      <ul className="space-y-2">
                        {group.subcategories.map((subcategory) => (
                          <li
                            key={subcategory.id}
                            className="flex flex-col gap-2 rounded border px-3 py-2 text-sm sm:flex-row sm:items-center sm:gap-3"
                          >
                            {editingSubcategoryId === subcategory.id ? (
                              <>
                                <input
                                  type="text"
                                  maxLength={200}
                                  value={editingSubcategoryName}
                                  onChange={(event) =>
                                    setEditingSubcategoryName(event.target.value)
                                  }
                                  className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                                />
                                <select
                                  value={editingSubcategoryCategoryId}
                                  onChange={(event) =>
                                    setEditingSubcategoryCategoryId(event.target.value)
                                  }
                                  className="rounded border border-gray-300 px-2 py-1 text-sm"
                                >
                                  <option value="">Select category</option>
                                  {sortedCategories.map((category) => (
                                    <option key={category.id} value={category.id}>
                                      {category.name}
                                    </option>
                                  ))}
                                </select>
                              </>
                            ) : (
                              <span className="flex-1">{subcategory.name}</span>
                            )}

                            <div className="flex items-center gap-2">
                              {editingSubcategoryId === subcategory.id ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={handleSaveSubcategoryEdit}
                                    disabled={!canUpdateSettings}
                                    className="rounded bg-green-600 px-2 py-1 text-xs text-white disabled:opacity-60"
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
                                    className="rounded border px-2 py-1 text-xs"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                canUpdateSettings && (
                                  <button
                                    type="button"
                                    onClick={() => startSubcategoryEdit(subcategory)}
                                    className="rounded border px-2 py-1 text-xs"
                                  >
                                    Edit
                                  </button>
                                )
                              )}

                              {canDeleteSettings && (
                                <button
                                  type="button"
                                  onClick={() => handleDeleteSubcategory(subcategory.id)}
                                  className="rounded bg-red-600 px-2 py-1 text-xs text-white"
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        {error && <p role="alert" className="text-sm text-red-700">{error} <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)} className="underline">Reload settings</button></p>}
        {message && <p role="status" className="text-sm text-green-700">{message}</p>}
      </PageContainer>
    </div>
  );
}
