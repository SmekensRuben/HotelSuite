import React, { useEffect, useMemo, useState } from "react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSettings, setSettings } from "../../services/firebaseSettings";

function sortByName(items) {
  return [...items].sort((firstItem, secondItem) =>
    firstItem.name.localeCompare(secondItem.name, undefined, { sensitivity: "base" })
  );
}

export default function SettingsCatalogPage() {
  const { hotelUid } = useHotelContext();
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

  const groupedSubcategories = useMemo(() => {
    const groupedMap = sortedCategories.map((category) => ({
      category,
      subcategories: sortByName(
        subcategories.filter((subcategory) => subcategory.categoryId === category.id)
      ),
    }));

    const unlinkedSubcategories = sortByName(
      subcategories.filter(
        (subcategory) =>
          !sortedCategories.some((category) => category.id === subcategory.categoryId)
      )
    );

    if (unlinkedSubcategories.length > 0) {
      groupedMap.push({
        category: { id: "unlinked", name: "Unlinked" },
        subcategories: unlinkedSubcategories,
      });
    }

    return groupedMap;
  }, [sortedCategories, subcategories]);

  const handleLogout = async () => {
    await signOut(auth);
    sessionStorage.clear();
    window.location.href = "/login";
  };

  useEffect(() => {
    if (!hotelUid) return;

    const loadCatalog = async () => {
      setLoading(true);
      const settings = await getSettings(hotelUid);
      const loadedCategories = Object.entries(settings?.catalogCategories || {}).map(
        ([id, value]) => ({
          id,
          name: value?.name || "",
        })
      );

      const loadedSubcategories = Object.entries(
        settings?.catalogSubcategories || {}
      ).map(([id, value]) => ({
        id,
        name: value?.name || "",
        categoryId: value?.categoryId || "",
      }));

      setCategories(loadedCategories);
      setSubcategories(loadedSubcategories);
      setLoading(false);
    };

    loadCatalog();
  }, [hotelUid]);

  const persistCatalog = async (nextCategories, nextSubcategories) => {
    const catalogCategories = nextCategories.reduce((accumulator, category) => {
      accumulator[category.id] = { name: category.name };
      return accumulator;
    }, {});

    const catalogSubcategories = nextSubcategories.reduce(
      (accumulator, subcategory) => {
        accumulator[subcategory.id] = {
          name: subcategory.name,
          categoryId: subcategory.categoryId,
        };
        return accumulator;
      },
      {}
    );

    await setSettings(hotelUid, {
      catalogCategories,
      catalogSubcategories,
    });
  };

  const handleAddCategory = async (event) => {
    event.preventDefault();
    const cleanedName = categoryName.trim();
    if (!hotelUid || !cleanedName) return;

    setSavingCategory(true);
    setMessage("");

    const nextCategories = [
      ...categories,
      {
        id: crypto.randomUUID(),
        name: cleanedName,
      },
    ];

    await persistCatalog(nextCategories, subcategories);
    setCategories(nextCategories);
    setCategoryName("");
    setSavingCategory(false);
    setMessage("Category created.");
  };

  const handleAddSubcategory = async (event) => {
    event.preventDefault();
    const cleanedName = subcategoryName.trim();

    if (!hotelUid || !cleanedName || !subcategoryCategoryId) {
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

    await persistCatalog(categories, nextSubcategories);
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
    if (!hotelUid || !editingCategoryId || !cleanedName) return;

    const nextCategories = categories.map((category) =>
      category.id === editingCategoryId ? { ...category, name: cleanedName } : category
    );

    await persistCatalog(nextCategories, subcategories);
    setCategories(nextCategories);
    setEditingCategoryId("");
    setEditingCategoryName("");
    setMessage("Category updated.");
  };

  const handleDeleteCategory = async (categoryId) => {
    if (!hotelUid || !categoryId) return;

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

    await persistCatalog(nextCategories, nextSubcategories);
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

    await persistCatalog(categories, nextSubcategories);
    setSubcategories(nextSubcategories);
    setEditingSubcategoryId("");
    setEditingSubcategoryName("");
    setEditingSubcategoryCategoryId("");
    setMessage("Subcategory updated.");
  };

  const handleDeleteSubcategory = async (subcategoryId) => {
    if (!hotelUid || !subcategoryId) return;

    const shouldDelete = window.confirm("Delete this subcategory?");
    if (!shouldDelete) return;

    const nextSubcategories = subcategories.filter(
      (subcategory) => subcategory.id !== subcategoryId
    );

    await persistCatalog(categories, nextSubcategories);
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
          <h1 className="text-3xl font-semibold">Settings Catalog</h1>
        </div>

        <Card>
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Categories</h2>
            <form onSubmit={handleAddCategory} className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                value={categoryName}
                onChange={(event) => setCategoryName(event.target.value)}
                placeholder="New category"
                className="rounded border border-gray-300 px-3 py-2 text-sm flex-1"
              />
              <button
                type="submit"
                disabled={savingCategory}
                className="bg-[#b41f1f] text-white px-4 py-2 rounded font-semibold shadow hover:bg-[#961919] transition-colors disabled:opacity-60"
              >
                {savingCategory ? "Adding..." : "Add category"}
              </button>
            </form>

            {loading ? (
              <p className="text-gray-600">Loading data...</p>
            ) : sortedCategories.length === 0 ? (
              <p className="text-gray-600 text-sm">No categories yet.</p>
            ) : (
              <ul className="space-y-2">
                {sortedCategories.map((category) => (
                  <li
                    key={category.id}
                    className="border rounded px-3 py-2 text-sm flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3"
                  >
                    {editingCategoryId === category.id ? (
                      <input
                        type="text"
                        value={editingCategoryName}
                        onChange={(event) => setEditingCategoryName(event.target.value)}
                        className="rounded border border-gray-300 px-2 py-1 text-sm flex-1"
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
                            className="text-xs px-2 py-1 rounded bg-green-600 text-white"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCategoryId("");
                              setEditingCategoryName("");
                            }}
                            className="text-xs px-2 py-1 rounded border"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startCategoryEdit(category)}
                          className="text-xs px-2 py-1 rounded border"
                        >
                          Edit
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => handleDeleteCategory(category.id)}
                        className="text-xs px-2 py-1 rounded bg-red-600 text-white"
                      >
                        Delete
                      </button>
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
                className="rounded border border-gray-300 px-3 py-2 text-sm sm:col-span-1"
              />
              <select
                value={subcategoryCategoryId}
                onChange={(event) => setSubcategoryCategoryId(event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm sm:col-span-1"
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
                disabled={savingSubcategory || sortedCategories.length === 0}
                className="bg-[#b41f1f] text-white px-4 py-2 rounded font-semibold shadow hover:bg-[#961919] transition-colors disabled:opacity-60 sm:col-span-1"
              >
                {savingSubcategory ? "Adding..." : "Add subcategory"}
              </button>
            </form>

            {loading ? (
              <p className="text-gray-600">Loading data...</p>
            ) : subcategories.length === 0 ? (
              <p className="text-gray-600 text-sm">No subcategories yet.</p>
            ) : (
              <div className="space-y-4">
                {groupedSubcategories.map((group) => (
                  <div key={group.category.id} className="space-y-2">
                    <h3 className="text-sm font-semibold text-gray-700">{group.category.name}</h3>
                    {group.subcategories.length === 0 ? (
                      <p className="text-gray-500 text-xs">No subcategories in this category.</p>
                    ) : (
                      <ul className="space-y-2">
                        {group.subcategories.map((subcategory) => (
                          <li
                            key={subcategory.id}
                            className="border rounded px-3 py-2 text-sm flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3"
                          >
                            {editingSubcategoryId === subcategory.id ? (
                              <>
                                <input
                                  type="text"
                                  value={editingSubcategoryName}
                                  onChange={(event) =>
                                    setEditingSubcategoryName(event.target.value)
                                  }
                                  className="rounded border border-gray-300 px-2 py-1 text-sm flex-1"
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
                                    className="text-xs px-2 py-1 rounded bg-green-600 text-white"
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
                                    className="text-xs px-2 py-1 rounded border"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => startSubcategoryEdit(subcategory)}
                                  className="text-xs px-2 py-1 rounded border"
                                >
                                  Edit
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={() => handleDeleteSubcategory(subcategory.id)}
                                className="text-xs px-2 py-1 rounded bg-red-600 text-white"
                              >
                                Delete
                              </button>
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
