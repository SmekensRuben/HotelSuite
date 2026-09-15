export const LIGHTHOUSE_RATE_BASIS = "INCL_VAT_CONSUMER";
export const MARKET_CONTEXT_MODEL_VERSION = "market-context-v1";
export const PUBLIC_MARKET_PRODUCT_WARNING = Object.freeze({
  code: "PUBLIC_MARKET_PRODUCT_NOT_NORMALIZED",
  message: "Public market rates may differ from the group quote in meal basis, occupancy, room type and booking conditions.",
});

const finiteOrNull = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** Parse a Lighthouse consumer price without applying VAT or contribution logic. */
export function parseLighthouseRateStatus(value) {
  const rawValue = value ?? null;
  if (typeof value === "number") return { rawValue, rateInclVat: Number.isFinite(value) && value >= 0 ? value : null, availabilityStatus: Number.isFinite(value) && value >= 0 ? "AVAILABLE" : "UNAVAILABLE" };
  if (typeof value !== "string") return { rawValue, rateInclVat: null, availabilityStatus: "UNAVAILABLE" };
  const compact = value.trim().replace(/[€\s]/g, "");
  const statusValue = value.trim().toUpperCase().replace(/[\s_-]+/g, " ");
  if (/^SOLD OUT$/.test(statusValue)) return { rawValue, rateInclVat: null, availabilityStatus: "SOLD_OUT" };
  if (/^LOS\s*\d+$/i.test(value.trim())) return { rawValue, rateInclVat: null, availabilityStatus: "LOS_RESTRICTION" };
  if (statusValue === "CLOSED") return { rawValue, rateInclVat: null, availabilityStatus: "CLOSED" };
  if (!compact || !/^[+-]?\d+(?:[.,]\d+)?$/.test(compact)) return { rawValue, rateInclVat: null, availabilityStatus: "UNAVAILABLE" };
  const number = Number(compact.replace(",", "."));
  return { rawValue, rateInclVat: Number.isFinite(number) && number >= 0 ? number : null, availabilityStatus: Number.isFinite(number) && number >= 0 ? "AVAILABLE" : "UNAVAILABLE" };
}

export const parseLighthousePublicRate = (value) => parseLighthouseRateStatus(value).rateInclVat;

const parsePercentage = (value) => {
  if (typeof value === "string") value = value.trim().replace("%", "").replace(",", ".");
  const number = finiteOrNull(value);
  if (number === null) return null;
  return number > 1 ? number / 100 : number;
};

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const difference = (left, right) => left === null || right === null ? { amount: null, percentage: null } : {
  amount: left - right,
  percentage: right === 0 ? null : (left - right) / right,
};

export function marketPricingConfidence(coverage, hasRates = true) {
  if (!hasRates || coverage === null) return "UNAVAILABLE";
  if (coverage >= 0.8) return "HIGH";
  if (coverage >= 0.6) return "MEDIUM";
  return "LOW";
}

export function calculateMarketPricingDate({ stayDate, requestedRooms, lighthouseRow = {}, compset = {}, competitors = [] }) {
  const configured = competitors.filter((item) => item.active && item.includeInMarketContext && Number(item.marketRelevanceWeight) > 0);
  const configuredActiveWeight = configured.reduce((sum, item) => sum + Number(item.marketRelevanceWeight), 0);
  const configuredStatuses = configured.map((item) => ({
    item,
    parsed: item.lighthouseFieldName ? parseLighthouseRateStatus(lighthouseRow[item.lighthouseFieldName]) : parseLighthouseRateStatus(null),
  }));
  const available = configuredStatuses.flatMap(({ item, parsed }) => {
    return parsed.rateInclVat === null ? [] : [{
      competitorId: item.id || item.competitorId,
      displayName: item.displayName || item.id || item.competitorId,
      lighthouseFieldName: item.lighthouseFieldName || null,
      publicRateInclVat: parsed.rateInclVat,
      rawLighthouseValue: parsed.rawValue,
      availabilityStatus: parsed.availabilityStatus,
      configuredWeight: Number(item.marketRelevanceWeight),
      active: Boolean(item.active),
      includeInMarketContext: Boolean(item.includeInMarketContext),
      groupIntelligenceEnabled: Boolean(item.groupIntelligenceEnabled),
    }];
  });
  const availableWeight = available.reduce((sum, item) => sum + item.configuredWeight, 0);
  const statusWeight = (status) => configuredStatuses.filter(({ parsed }) => parsed.availabilityStatus === status).reduce((sum, { item }) => sum + Number(item.marketRelevanceWeight), 0);
  const soldOutWeight = statusWeight("SOLD_OUT");
  const restrictedWeight = statusWeight("LOS_RESTRICTION");
  const closedWeight = statusWeight("CLOSED");
  const competitorsWithWeights = available.map((item) => ({
    ...item,
    normalizedEffectiveWeight: availableWeight > 0 ? item.configuredWeight / availableWeight : null,
  }));
  const rates = competitorsWithWeights.map((item) => item.publicRateInclVat);
  const weighted = availableWeight > 0
    ? competitorsWithWeights.reduce((sum, item) => sum + item.publicRateInclVat * item.normalizedEffectiveWeight, 0)
    : null;
  const own = compset.ownHotelLighthouseFieldName
    ? parseLighthousePublicRate(lighthouseRow[compset.ownHotelLighthouseFieldName])
    : null;
  const midpoint = median(rates);
  const coverage = configuredActiveWeight > 0 ? availableWeight / configuredActiveWeight : null;
  const ownVsWeighted = difference(own, weighted);
  const ownVsMedian = difference(own, midpoint);

  return {
    stayDate,
    requestedRooms: Math.max(0, Number(requestedRooms) || 0),
    ownPublicRateInclVat: own,
    validCompetitorRates: competitorsWithWeights,
    competitors: competitors.map((item) => {
      const valid = competitorsWithWeights.find((availableItem) => availableItem.competitorId === (item.id || item.competitorId));
      const parsed = item.lighthouseFieldName ? parseLighthouseRateStatus(lighthouseRow[item.lighthouseFieldName]) : parseLighthouseRateStatus(null);
      return valid || {
        competitorId: item.id || item.competitorId, displayName: item.displayName || item.id || item.competitorId,
        lighthouseFieldName: item.lighthouseFieldName || null, publicRateInclVat: null, rawLighthouseValue: parsed.rawValue, availabilityStatus: parsed.availabilityStatus,
        configuredWeight: Number(item.marketRelevanceWeight) || 0, normalizedEffectiveWeight: null,
        active: Boolean(item.active), includeInMarketContext: Boolean(item.includeInMarketContext),
        groupIntelligenceEnabled: Boolean(item.groupIntelligenceEnabled),
      };
    }),
    compsetMedianInclVat: midpoint,
    compsetLowInclVat: rates.length ? Math.min(...rates) : null,
    compsetHighInclVat: rates.length ? Math.max(...rates) : null,
    weightedCompsetReferenceInclVat: weighted,
    compsetCoverage: coverage,
    coverage,
    configuredIncludedWeight: configuredActiveWeight,
    availableRateWeight: availableWeight,
    soldOutWeight,
    restrictedWeight,
    closedWeight,
    rateCoverage: coverage,
    soldOutWeightShare: configuredActiveWeight > 0 ? soldOutWeight / configuredActiveWeight : null,
    restrictedWeightShare: configuredActiveWeight > 0 ? restrictedWeight / configuredActiveWeight : null,
    closedWeightShare: configuredActiveWeight > 0 ? closedWeight / configuredActiveWeight : null,
    marketPricingConfidence: marketPricingConfidence(coverage, rates.length > 0),
    ownVsWeightedCompsetAmount: ownVsWeighted.amount,
    ownVsWeightedCompsetPercentage: ownVsWeighted.percentage,
    ownVsCompsetMedianAmount: ownVsMedian.amount,
    ownVsCompsetMedianPercentage: ownVsMedian.percentage,
    marketDemand: parsePercentage(lighthouseRow["Market demand"]),
    myOtb: parsePercentage(lighthouseRow["My OTB"]),
  };
}

const roomNightWeighted = (dates, field) => {
  const valid = dates.filter((item) => item[field] !== null && item[field] !== undefined && item.requestedRooms > 0);
  const denominator = valid.reduce((sum, item) => sum + item.requestedRooms, 0);
  return denominator ? valid.reduce((sum, item) => sum + item[field] * item.requestedRooms, 0) / denominator : null;
};

export function calculateGroupStayMarketSummary(stayDates) {
  const rateCoverage = roomNightWeighted(stayDates, "rateCoverage");
  return {
    weightedOwnPublicRateInclVat: roomNightWeighted(stayDates, "ownPublicRateInclVat"),
    weightedMarketReferenceInclVat: roomNightWeighted(stayDates, "weightedCompsetReferenceInclVat"),
    weightedCompsetMedianInclVat: roomNightWeighted(stayDates, "compsetMedianInclVat"),
    overallCoverage: roomNightWeighted(stayDates, "coverage"),
    rateCoverage,
    marketPricingConfidence: marketPricingConfidence(rateCoverage, stayDates.some((item) => item.weightedCompsetReferenceInclVat !== null)),
    weightedSoldOutWeightShare: roomNightWeighted(stayDates, "soldOutWeightShare"),
    weightedRestrictedWeightShare: roomNightWeighted(stayDates, "restrictedWeightShare"),
    weightedMarketDemand: roomNightWeighted(stayDates, "marketDemand"),
  };
}

export function buildMarketContextSnapshot({ lighthouseSnapshotDate, compset = {}, competitors = [], lighthouseByDate = {}, roomsByDate = [] }) {
  const stayDates = roomsByDate.map((room) => calculateMarketPricingDate({
    stayDate: room.date,
    requestedRooms: room.rooms,
    lighthouseRow: lighthouseByDate[room.date] || {},
    compset,
    competitors,
  }));
  return {
    lighthouseSnapshotDate: lighthouseSnapshotDate || null,
    rateBasis: LIGHTHOUSE_RATE_BASIS,
    marketContextModelVersion: MARKET_CONTEXT_MODEL_VERSION,
    warnings: [PUBLIC_MARKET_PRODUCT_WARNING],
    ownHotelFieldName: compset.ownHotelLighthouseFieldName || null,
    sourceContext: {
      lighthouseChannel: compset.lighthouseChannel ?? null,
      lighthouseDevice: compset.lighthouseDevice ?? null,
      lighthouseOccupancy: compset.lighthouseOccupancy ?? null,
      lighthouseLengthOfStay: compset.lighthouseLengthOfStay ?? null,
      lighthouseMealFilter: compset.lighthouseMealFilter ?? null,
      lighthouseRoomFilter: compset.lighthouseRoomFilter ?? null,
    },
    competitorSettings: competitors.map((item) => ({
      competitorId: item.id || item.competitorId,
      displayName: item.displayName || null,
      lighthouseFieldName: item.lighthouseFieldName || null,
      configuredWeight: Number(item.marketRelevanceWeight) || 0,
      active: Boolean(item.active),
      includeInMarketContext: Boolean(item.includeInMarketContext),
      groupIntelligenceEnabled: Boolean(item.groupIntelligenceEnabled),
    })),
    groupStaySummary: calculateGroupStayMarketSummary(stayDates),
    stayDates,
  };
}
