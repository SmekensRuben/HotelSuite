export const getIngredients = vi.fn().mockResolvedValue([
  { id: "a", name: "Melk", category: "zuivel", supplier: "Colruyt", active: true, unitsPerPurchaseUnit: 12, stockUnit: "fles", brand: "Test", pricePerPurchaseUnit: 15, lastPriceUpdate: Date.now(), imageUrl: "" },
  // ...meer indien nodig
]);
export const getIngredientsIndexed = vi.fn().mockResolvedValue([]);
export const addIngredient = vi.fn();
export const updateIngredient = vi.fn();
export const deleteIngredient = vi.fn();
export const addIngredientPriceHistory = vi.fn();
export const getIngredientPriceHistory = vi.fn().mockResolvedValue([]);
