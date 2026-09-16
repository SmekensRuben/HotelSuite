export const LEAD_TIME_BANDS = Object.freeze([
  { label: "0–30", min: 0, max: 30 }, { label: "31–60", min: 31, max: 60 },
  { label: "61–90", min: 61, max: 90 }, { label: "91–180", min: 91, max: 180 },
  { label: "181–365", min: 181, max: 365 }, { label: "366+", min: 366, max: Infinity },
]);
export const leadTimeBand = (days) => days == null || !Number.isFinite(Number(days)) ? "UNKNOWN" : LEAD_TIME_BANDS.find((band) => Number(days) >= band.min && Number(days) <= band.max)?.label || "UNKNOWN";
export const decisionWinRate = (quotes) => {
  const won = quotes.filter((q) => q.commercialStatus === "WON").length;
  const lost = quotes.filter((q) => q.commercialStatus === "LOST").length;
  return won + lost ? won / (won + lost) : null;
};
export function frozenDecisionValue(quote, field) { return quote.outcome?.decisionSnapshot?.[field] ?? null; }
export function averageQuoteVariance(quotes, comparisonField) {
  const rows = quotes.map((quote) => ({ final: frozenDecisionValue(quote, "finalQuotedRateInclVat"), comparison: frozenDecisionValue(quote, comparisonField) })).filter(({ final, comparison }) => Number.isFinite(final) && Number.isFinite(comparison));
  if (!rows.length) return { amount: null, percentage: null, sampleCount: 0 };
  const amount = rows.reduce((sum, row) => sum + row.final - row.comparison, 0) / rows.length;
  const percentages = rows.filter((row) => row.comparison !== 0).map((row) => (row.final - row.comparison) / row.comparison);
  return { amount, percentage: percentages.length ? percentages.reduce((a, b) => a + b, 0) / percentages.length : null, sampleCount: rows.length };
}
