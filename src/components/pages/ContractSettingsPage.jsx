import React, { useEffect, useMemo, useState } from "react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSettings, setSettings } from "../../services/firebaseSettings";
import { usePermission } from "../../hooks/usePermission";

function sortByName(items) {
  return [...items].sort((firstItem, secondItem) =>
    firstItem.name.localeCompare(secondItem.name, undefined, { sensitivity: "base" })
  );
}

export default function ContractSettingsPage() {
  const { hotelUid } = useHotelContext();
  const canCreateSettings = usePermission("settings", "create");
  const canUpdateSettings = usePermission("settings", "update");
  const canDeleteSettings = usePermission("settings", "delete");
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
    if (!hotelUid) return;

    const loadSettings = async () => {
      setLoading(true);
      const settings = await getSettings(hotelUid);
      const loadedCategories = Object.entries(settings?.contractCategories || {}).map(
        ([id, value]) => ({
          id,
          name: value?.name || "",
        })
      );

      const categoryIds = new Set(loadedCategories.map((category) => category.id));

      const loadedSubcategories = Object.entries(settings?.contractSubcategories || {})
        .map(([id, value]) => ({
          id,
          name: value?.name || "",
          categoryId: value?.categoryId || "",
        }))
        .filter((subcategory) => subcategory.categoryId && categoryIds.has(subcategory.categoryId));

      setCategories(loadedCategories);
      setSubcategories(loadedSubcategories);
      setLoading(false);
    };

    loadSettings();
  }, [hotelUid]);

  const persistSettings = async (nextCategories, nextSubcategories) => {
    const contractCategories = nextCategories.reduce((accumulator, category) => {
      accumulator[category.id] = { name: category.name };
      return accumulator;
    }, {});

    const contractSubcategories = nextSubcategories.reduce((accumulator, subcategory) => {
      accumulator[subcategory.id] = {
        name: subcategory.name,
        categoryId: subcategory.categoryId,
      };
      return accumulator;
    }, {});

    await setSettings(hotelUid, {
      contractCategories,
      contractSubcategories,
    });
  };

  const handleAddCategory = async (event) => {
    event.preventDefault();
    const cleanedName = categoryName.trim();
    if (!canCreateSettings || !hotelUid || !cleanedName) return;

    setSavingCategory(true);
    setMessage("");

    const nextCategories = [
      ...categories,
      {
        id: crypto.randomUUID(),
        name: cleanedName,
      },
    ];

    await persistSettings(nextCategories, subcategories);
    setCategories(nextCategories);
    setCategoryName("");
    setSavingCategory(false);
    setMessage("Category created.");
  };

  const handleAddSubcategory = async (event) => {
    event.preventDefault();
    const cleanedName = subcategoryName.trim();

    if (!canCreateSettings || !hotelUid || !cleanedName || !subcategoryCategoryId) {
      setMessage("Please select one category for this subcategory.");
      return;
    }

    setSavingSubcategory(true);
    setMessage("");

    const nextSubcategories = [
      ...subcategories,
      {
        id: crypto.randomUUID(),
        name: cleanedName,
        categoryId: subcategoryCategoryId,
      },
    ];

    await persistSettings(categories, nextSubcategories);
    setSubcategories(nextSubcategories);
    setSubcategoryName("");
    setSubcategoryCategoryId("");
    setSavingSubcategory(false);
    setMessage("Subcategory created.");
  };

  const startCategoryEdit = (category) => {
    setEditingCategoryId(category.id);
    setEditingCategoryName(category.name);
  };

  const handleSaveCategoryEdit = async () => {
    const cleanedName = editingCategoryName.trim();
    if (!canUpdateSettings || !hotelUid || !editingCategoryId || !cleanedName) return;

    const nextCategories = categories.map((category) =>
      category.id === editingCategoryId ? { ...category, name: cleanedName } : category
    );

    await persistSettings(nextCategories, subcategories);
    setCategories(nextCategories);
    setEditingCategoryId("");
    setEditingCategoryName("");
    setMessage("Category updated.");
  };

  const handleDeleteCategory = async (categoryId) => {
    if (!canDeleteSettings || !hotelUid || !categoryId) return;

    const linkedSubcategories = subcategories.filter(
      (subcategory) => subcategory.categoryId === categoryId
    );

    const shouldDelete = window.confirm(
      linkedSubcategories.length > 0
        ? "This category has linked subcategories. Deleting it will also delete those subcategories. Continue?"
        : "Delete this category?"
    );

    if (!shouldDelete) return;

    const nextCategories = categories.filter((category) => category.id !== categoryId);
    const nextSubcategories = subcategories.filter(
      (subcategory) => subcategory.categoryId !== categoryId
    );

    await persistSettings(nextCategories, nextSubcategories);
    setCategories(nextCategories);
    setSubcategories(nextSubcategories);
    setEditingCategoryId("");
    setEditingCategoryName("");
    setMessage("Category deleted.");
  };

  const startSubcategoryEdit = (subcategory) => {
    setEditingSubcategoryId(subcategory.id);
    setEditingSubcategoryName(subcategory.name);
    setEditingSubcategoryCategoryId(subcategory.categoryId);
  };

  const handleSaveSubcategoryEdit = async () => {
    const cleanedName = editingSubcategoryName.trim();
    if (
      !canUpdateSettings ||
      !hotelUid ||
      !editingSubcategoryId ||
      !cleanedName ||
      !editingSubcategoryCategoryId
    ) {
      setMessage("Each subcategory must be linked to one category.");
      return;
    }

    const nextSubcategories = subcategories.map((subcategory) =>
      subcategory.id === editingSubcategoryId
        ? {
            ...subcategory,
            name: cleanedName,
            categoryId: editingSubcategoryCategoryId,
          }
        : subcategory
    );

    await persistSettings(categories, nextSubcategories);
    setSubcategories(nextSubcategories);
    setEditingSubcategoryId("");
    setEditingSubcategoryName("");
    setEditingSubcategoryCategoryId("");
    setMessage("Subcategory updated.");
  };

  const handleDeleteSubcategory = async (subcategoryId) => {
    if (!canDeleteSettings || !hotelUid || !subcategoryId) return;

    const shouldDelete = window.confirm("Delete this subcategory?");
    if (!shouldDelete) return;

    const nextSubcategories = subcategories.filter(
      (subcategory) => subcategory.id !== subcategoryId
    );

    await persistSettings(categories, nextSubcategories);
    setSubcategories(nextSubcategories);
    setEditingSubcategoryId("");
    setEditingSubcategoryName("");
    setEditingSubcategoryCategoryId("");
    setMessage("Subcategory deleted.");
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

        {message && <p className="text-sm text-green-700">{message}</p>}
      </PageContainer>
    </div>
  );
}
