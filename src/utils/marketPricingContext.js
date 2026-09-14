export const LIGHTHOUSE_RATE_BASIS = "INCL_VAT_CONSUMER";
export const MARKET_CONTEXT_MODEL_VERSION = "market-context-v1";

const finiteOrNull = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** Parse a Lighthouse consumer price without applying VAT or contribution logic. */
export function parseLighthousePublicRate(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const compact = value.trim().replace(/[€\s]/g, "");
  if (!compact || !/^[+-]?\d+(?:[.,]\d+)?$/.test(compact)) return null;
  const number = Number(compact.replace(",", "."));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

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
  const available = configured.flatMap((item) => {
    const rate = item.lighthouseFieldName ? parseLighthousePublicRate(lighthouseRow[item.lighthouseFieldName]) : null;
    return rate === null ? [] : [{
      competitorId: item.id || item.competitorId,
      displayName: item.displayName || item.id || item.competitorId,
      lighthouseFieldName: item.lighthouseFieldName || null,
      publicRateInclVat: rate,
      configuredWeight: Number(item.marketRelevanceWeight),
      active: Boolean(item.active),
      includeInMarketContext: Boolean(item.includeInMarketContext),
      groupIntelligenceEnabled: Boolean(item.groupIntelligenceEnabled),
    }];
  });
  const availableWeight = available.reduce((sum, item) => sum + item.configuredWeight, 0);
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
      return valid || {
        competitorId: item.id || item.competitorId, displayName: item.displayName || item.id || item.competitorId,
        lighthouseFieldName: item.lighthouseFieldName || null, publicRateInclVat: null,
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
  return {
    weightedOwnPublicRateInclVat: roomNightWeighted(stayDates, "ownPublicRateInclVat"),
    weightedMarketReferenceInclVat: roomNightWeighted(stayDates, "weightedCompsetReferenceInclVat"),
    weightedCompsetMedianInclVat: roomNightWeighted(stayDates, "compsetMedianInclVat"),
    overallCoverage: roomNightWeighted(stayDates, "coverage"),
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
