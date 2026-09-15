export const NIGHTLY_MEAL_BASIS = Object.freeze({ RO: "RO", BB: "BB" });
export const NIGHTLY_MEAL_BASIS_VALUES = Object.freeze(Object.values(NIGHTLY_MEAL_BASIS));
export const GROUP_QUOTE_INPUT_SCHEMA_VERSION = "group-quote-v3-meal-basis";

export const MEAL_BASIS_WARNINGS = Object.freeze({
  BB_WITH_ZERO_BREAKFAST_PAX: "Meal basis is BB but breakfast pax is zero for this stay night. Verify that breakfast costs have been entered correctly.",
  RO_WITH_BREAKFAST_PAX: "Meal basis is RO but breakfast pax is greater than zero. Breakfast cost will still be included in the contribution calculation.",
});

export function deriveExplicitQuoteMealBasis(roomsByDate = []) {
  if (!roomsByDate.length || roomsByDate.some((night) => !NIGHTLY_MEAL_BASIS_VALUES.includes(night.mealBasis))) return "LEGACY_UNKNOWN";
  const bases = new Set(roomsByDate.map((night) => night.mealBasis));
  return bases.size === 1 ? [...bases][0] : "MIXED";
}

export function getMealBasisDataQualityWarnings(roomsByDate = []) {
  return roomsByDate.flatMap((night) => {
    const pax = Number(night.breakfastPax) || 0;
    if (night.mealBasis === NIGHTLY_MEAL_BASIS.BB && pax === 0) return [{ code: "BB_WITH_ZERO_BREAKFAST_PAX", message: MEAL_BASIS_WARNINGS.BB_WITH_ZERO_BREAKFAST_PAX, stayDate: night.date }];
    if (night.mealBasis === NIGHTLY_MEAL_BASIS.RO && pax > 0) return [{ code: "RO_WITH_BREAKFAST_PAX", message: MEAL_BASIS_WARNINGS.RO_WITH_BREAKFAST_PAX, stayDate: night.date }];
    return [];
  });
}
