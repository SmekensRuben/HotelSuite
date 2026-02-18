import React, { useEffect, useMemo, useState } from "react";
import HeaderBar from "../layout/HeaderBar";
import PageContainer from "../layout/PageContainer";
import { Card } from "../layout/Card";
import { auth, signOut } from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { getSettings, setSettings } from "../../services/firebaseSettings";

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

    const newCategory = {
      id: crypto.randomUUID(),
      name: cleanedName,
    };

    const nextCategories = [...categories, newCategory];
    await persistCatalog(nextCategories, subcategories);
    setCategories(nextCategories);
    setCategoryName("");
    setSavingCategory(false);
    setMessage("Categorie toegevoegd.");
  };

  const handleAddSubcategory = async (event) => {
    event.preventDefault();
    const cleanedName = subcategoryName.trim();

    if (!hotelUid || !cleanedName || !subcategoryCategoryId) {
      setMessage("Kies een categorie voor de subcategorie.");
      return;
    }

    setSavingSubcategory(true);
    setMessage("");

    const newSubcategory = {
      id: crypto.randomUUID(),
      name: cleanedName,
      categoryId: subcategoryCategoryId,
    };

    const nextSubcategories = [...subcategories, newSubcategory];
    await persistCatalog(categories, nextSubcategories);
    setSubcategories(nextSubcategories);
    setSubcategoryName("");
    setSubcategoryCategoryId("");
    setSavingSubcategory(false);
    setMessage("Subcategorie toegevoegd.");
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
                placeholder="Nieuwe categorie"
                className="rounded border border-gray-300 px-3 py-2 text-sm flex-1"
              />
              <button
                type="submit"
                disabled={savingCategory}
                className="bg-[#b41f1f] text-white px-4 py-2 rounded font-semibold shadow hover:bg-[#961919] transition-colors disabled:opacity-60"
              >
                {savingCategory ? "Toevoegen..." : "Categorie toevoegen"}
              </button>
            </form>

            {loading ? (
              <p className="text-gray-600">Gegevens laden...</p>
            ) : categories.length === 0 ? (
              <p className="text-gray-600 text-sm">Nog geen categorieën toegevoegd.</p>
            ) : (
              <ul className="space-y-2">
                {categories.map((category) => (
                  <li key={category.id} className="border rounded px-3 py-2 text-sm">
                    {category.name}
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
                placeholder="Nieuwe subcategorie"
                className="rounded border border-gray-300 px-3 py-2 text-sm sm:col-span-1"
              />
              <select
                value={subcategoryCategoryId}
                onChange={(event) => setSubcategoryCategoryId(event.target.value)}
                className="rounded border border-gray-300 px-3 py-2 text-sm sm:col-span-1"
              >
                <option value="">Selecteer categorie</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={savingSubcategory || categories.length === 0}
                className="bg-[#b41f1f] text-white px-4 py-2 rounded font-semibold shadow hover:bg-[#961919] transition-colors disabled:opacity-60 sm:col-span-1"
              >
                {savingSubcategory ? "Toevoegen..." : "Subcategorie toevoegen"}
              </button>
            </form>

            {loading ? (
              <p className="text-gray-600">Gegevens laden...</p>
            ) : subcategories.length === 0 ? (
              <p className="text-gray-600 text-sm">Nog geen subcategorieën toegevoegd.</p>
            ) : (
              <ul className="space-y-2">
                {subcategories.map((subcategory) => {
                  const category = categories.find(
                    (categoryItem) => categoryItem.id === subcategory.categoryId
                  );
                  return (
                    <li key={subcategory.id} className="border rounded px-3 py-2 text-sm">
                      <span className="font-semibold">{subcategory.name}</span>
                      <span className="text-gray-500"> · {category?.name || "Onbekende categorie"}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>

        {message && <p className="text-sm text-green-700">{message}</p>}
      </PageContainer>
    </div>
  );
}
