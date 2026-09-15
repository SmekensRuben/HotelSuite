import {
  addDoc,
  collection,
  db,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  documentId,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "../firebaseConfig";

const quotesPath = (hotelUid) => `hotels/${hotelUid}/quotes`;
export const GROUP_QUOTE_ANALYSIS_MODEL_VERSION = "group-contribution-v4-net-group-value";
export const MARKET_CONTEXT_MODEL_VERSION = "market-context-v1.1-rate-quality";
export const QUOTE_STATUSES = ["PENDING", "WON", "LOST", "DECLINED", "CANCELLED"];
export const LOST_REASONS = ["PRICE", "LOCATION", "PRODUCT", "MEETING_SPACE", "TERMS", "AVAILABILITY", "BRAND", "LOYALTY", "DATES_CHANGED", "CLIENT_CANCELLED", "COMPETITOR_RELATIONSHIP", "UNKNOWN", "OTHER"];
export const DECLINED_REASONS = ["ECONOMIC_FLOOR_TOO_HIGH", "CAPACITY", "OPERATIONAL", "ROOM_TYPE", "MEETING_SPACE", "STRATEGIC", "OTHER"];
export const SAVED_ANALYSIS_STALE_WARNING = Object.freeze({
  code: "SAVED_ANALYSIS_STALE",
  message: "Saved analysis is stale because analysis-affecting quote inputs changed.",
});

const ANALYSIS_FIELDS = ["startDate", "endDate", "roomsByDate", "breakfastPax", "groupCommissionPercentage", "analysisYears"];
const stableValue = (value) => JSON.stringify(value ?? null);
export const hasAnalysisAffectingChanges = (current = {}, updates = {}) => ANALYSIS_FIELDS.some((field) =>
  Object.prototype.hasOwnProperty.call(updates, field) && stableValue(current[field]) !== stableValue(updates[field])
);

const withId = (docSnap) => ({ id: docSnap.id, ...docSnap.data() });

export const subscribeQuotes = (hotelUid, callback) => {
  if (!hotelUid) return () => {};
  const ref = collection(db, quotesPath(hotelUid));
  return onSnapshot(ref, (snapshot) => {
    const quotes = snapshot.docs.map(withId).sort((left, right) =>
      String(right.startDate || right.quoteDate || "").localeCompare(
        String(left.startDate || left.quoteDate || "")
      )
    );
    callback(quotes);
  });
};

export const addQuote = async (hotelUid, quote) => {
  if (!hotelUid) throw new Error("Hotel ontbreekt");
  const document = await addDoc(collection(db, quotesPath(hotelUid)), {
    ...quote,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return document.id;
};

export const getQuote = async (hotelUid, quoteId) => {
  if (!hotelUid || !quoteId) return null;
  const ref = doc(db, `${quotesPath(hotelUid)}/${quoteId}`);
  const snapshot = await getDoc(ref);
  if (!snapshot.exists()) return null;
  return { id: snapshot.id, ...snapshot.data() };
};

export const updateQuote = async (hotelUid, quoteId, updates) => {
  if (!hotelUid || !quoteId) return;
  const ref = doc(db, `${quotesPath(hotelUid)}/${quoteId}`);
  await updateDoc(ref, { ...updates, updatedAt: serverTimestamp() });
};

export const deleteQuote = async (hotelUid, quoteId) => {
  if (!hotelUid || !quoteId) return;
  const ref = doc(db, `${quotesPath(hotelUid)}/${quoteId}`);
  await deleteDoc(ref);
};

export const getHistoryQuoteDates = async (hotelUid) => {
  if (!hotelUid) return [];
  const snapshot = await getDocs(
    collection(db, `hotels/${hotelUid}/reports/historyquotes/consideredDates`)
  );
  return snapshot.docs
    .filter((snapshotDocument) => /^\d{4}-\d{2}-\d{2}$/.test(snapshotDocument.id))
    .map((snapshotDocument) => ({
      id: snapshotDocument.id,
      date: snapshotDocument.id,
      ...snapshotDocument.data(),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
};

const reportPath = (hotelUid, report) => `hotels/${hotelUid}/reports/${report}`;

async function getLatestSnapshotStayDates(hotelUid, report) {
  const snapshots = await getDocs(query(
    collection(db, `${reportPath(hotelUid, report)}/snapshotDates`),
    orderBy(documentId(), "desc"),
    limit(1)
  ));
  const latest = snapshots.docs[0];
  if (!latest) return { snapshotDate: null, byDate: {} };
  const stayDates = await getDocs(collection(
    db,
    `${reportPath(hotelUid, report)}/snapshotDates/${latest.id}/stayDates`
  ));
  return {
    snapshotDate: latest.id,
    byDate: Object.fromEntries(stayDates.docs.map((item) => [item.id, { id: item.id, ...item.data() }])),
  };
}

export const getLatestHistoryForecastSnapshot = (hotelUid) =>
  getLatestSnapshotStayDates(hotelUid, "historyforecast");

export const getLatestLighthouseSnapshot = (hotelUid) =>
  getLatestSnapshotStayDates(hotelUid, "lightHouseData");

export const getGroupQuoteSettings = async (hotelUid) => {
  if (!hotelUid) return {};
  const snapshot = await getDoc(doc(db, `hotels/${hotelUid}/settings/groupQuotes`));
  return snapshot.exists() ? snapshot.data() : {};
};

export const saveGroupQuoteSettings = async (hotelUid, settings) => {
  if (!hotelUid) throw new Error("Hotel ontbreekt");
  await setDoc(doc(db, `hotels/${hotelUid}/settings/groupQuotes`), {
    ...settings,
    updatedAt: serverTimestamp(),
  }, { merge: true });
};

export const compsetSettingsPath = (hotelUid) => `hotels/${hotelUid}/settings/compset`;
export const compsetCompetitorsPath = (hotelUid) => `${compsetSettingsPath(hotelUid)}/competitors`;
export const competitorGroupQuotesPath = (hotelUid) => `hotels/${hotelUid}/competitorGroupQuotes`;

export async function getCompsetConfiguration(hotelUid) {
  if (!hotelUid) return { settings: {}, competitors: [] };
  // Exactly one document read and one subcollection read; analysis uses the results in memory.
  const [settingsSnapshot, competitorsSnapshot] = await Promise.all([
    getDoc(doc(db, compsetSettingsPath(hotelUid))),
    getDocs(collection(db, compsetCompetitorsPath(hotelUid))),
  ]);
  return {
    settings: settingsSnapshot.exists() ? settingsSnapshot.data() : {},
    competitors: competitorsSnapshot.docs
      .map(withId)
      .sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0)),
  };
}

export async function saveCompsetConfiguration(hotelUid, settings, competitors) {
  if (!hotelUid) throw new Error("Hotel ontbreekt");
  const sanitized = competitors.map((item, index) => {
    const weight = Number(item.marketRelevanceWeight);
    if (!Number.isFinite(weight) || weight < 0) throw new Error("Competitor relevance weights must be zero or greater.");
    const id = String(item.id || item.competitorId || "").trim();
    if (!id) throw new Error("Every competitor needs an identifier.");
    return { ...item, id, marketRelevanceWeight: weight, sortOrder: Number(item.sortOrder ?? index) };
  });
  await Promise.all([
    setDoc(doc(db, compsetSettingsPath(hotelUid)), {
      ...settings,
      lighthouseRateBasis: "INCL_VAT_CONSUMER",
      updatedAt: serverTimestamp(),
    }, { merge: true }),
    ...sanitized.map(({ id, ...item }) => setDoc(doc(db, `${compsetCompetitorsPath(hotelUid)}/${id}`), {
      ...item,
      createdAt: item.createdAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true })),
  ]);
}

const CONTROLLED_VALUES = Object.freeze({
  sourceType: ["LOST_GROUP", "WON_GROUP", "CLIENT_FEEDBACK", "SALES_INTELLIGENCE", "MANUAL_OBSERVATION", "OTHER"],
  mealBasis: ["RO", "BB", "HB", "FB", "OTHER", "UNKNOWN"],
  occupancyBasis: ["SINGLE", "DOUBLE", "MIXED", "UNKNOWN"],
  sourceConfidence: ["HIGH", "MEDIUM", "LOW"],
});

export function validateCompetitorGroupObservation(observation) {
  for (const [field, values] of Object.entries(CONTROLLED_VALUES)) {
    if (!values.includes(observation[field])) throw new Error(`Invalid ${field}.`);
  }
  const rate = Number(observation.competitorQuotedRateInclVat);
  if (!Number.isFinite(rate) || rate < 0) throw new Error("Competitor quoted rate must be a non-negative number including VAT.");
  if (!observation.competitorId) throw new Error("Competitor is required.");
  const publicRate = observation.publicRateAtObservationInclVat;
  if (publicRate !== null && publicRate !== undefined && (!Number.isFinite(Number(publicRate)) || Number(publicRate) < 0)) {
    throw new Error("Public rate at observation must be a non-negative number.");
  }
  return { ...observation, competitorQuotedRateInclVat: rate };
}

export async function saveCompetitorGroupObservation(hotelUid, observation) {
  if (!hotelUid) throw new Error("Hotel ontbreekt");
  const valid = validateCompetitorGroupObservation(observation);
  // Quote-linked observations use a stable document ID, preventing repeated outcome saves.
  const stableId = valid.sourceQuoteId
    ? `${String(valid.sourceQuoteId).replace(/[^a-zA-Z0-9_-]/g, "_")}_${String(valid.competitorId).replace(/[^a-zA-Z0-9_-]/g, "_")}`
    : null;
  const timestamps = { updatedAt: serverTimestamp() };
  if (stableId) {
    await setDoc(doc(db, `${competitorGroupQuotesPath(hotelUid)}/${stableId}`), {
      ...valid,
      ...timestamps,
      createdAt: valid.createdAt || serverTimestamp(),
    }, { merge: true });
    return stableId;
  }
  const created = await addDoc(collection(db, competitorGroupQuotesPath(hotelUid)), {
    ...valid,
    ...timestamps,
    createdAt: serverTimestamp(),
  });
  return created.id;
}

export async function getCompetitorGroupObservationCounts(hotelUid) {
  if (!hotelUid) return {};
  const snapshot = await getDocs(collection(db, competitorGroupQuotesPath(hotelUid)));
  return snapshot.docs.reduce((counts, item) => {
    const competitorId = item.data().competitorId;
    if (competitorId) counts[competitorId] = (counts[competitorId] || 0) + 1;
    return counts;
  }, {});
}

export function buildQuoteDecisionSnapshot(quote, outcome) {
  const guidance = quote.pricingGuidanceSnapshot || {};
  return {
    contributionModelVersion: quote.contributionModelVersion || quote.analysisModelVersion || null,
    marketContextModelVersion: quote.marketContextModelVersion || null,
    pricingGuidanceModelVersion: quote.pricingGuidanceModelVersion || null,
    economicFloorRateInclVat: guidance.economicFloorRateInclVat ?? quote.analysisContributionSnapshot?.economicFloorRateInclVat ?? null,
    targetRateInclVat: guidance.targetRateInclVat ?? null,
    stretchRateInclVat: guidance.stretchRateInclVat ?? null,
    finalQuotedRateInclVat: outcome.finalQuotedRateInclVat ?? null,
    quoteMealBasis: outcome.finalQuotedMealBasis || guidance.proposedRateMealBasis || null,
    displacementRatio: guidance.displacementRatio ?? null,
    marketAnchorInclVat: guidance.marketAnchorInclVat ?? null,
    weightedMarketDemand: guidance.weightedMarketDemand ?? null,
    marketContextConfidence: quote.marketContextSnapshot?.groupStaySummary?.marketPricingConfidence ?? null,
  };
}

export async function saveQuoteOutcome(hotelUid, quote, input) {
  if (!QUOTE_STATUSES.includes(input.status)) throw new Error("Invalid quote status.");
  if (input.status === "LOST" && input.lostReason && !LOST_REASONS.includes(input.lostReason)) throw new Error("Invalid lost reason.");
  if (input.status === "DECLINED" && input.declinedReason && !DECLINED_REASONS.includes(input.declinedReason)) throw new Error("Invalid declined reason.");
  const rate = input.finalQuotedRateInclVat === "" || input.finalQuotedRateInclVat === null || input.finalQuotedRateInclVat === undefined ? null : Number(input.finalQuotedRateInclVat);
  if (rate !== null && (!Number.isFinite(rate) || rate < 0)) throw new Error("Final quoted rate must be non-negative.");
  const now = new Date();
  const priorHistory = Array.isArray(quote.rateHistory) ? quote.rateHistory : [];
  const rateHistory = rate === null || priorHistory.at(-1)?.rateInclVat === rate ? priorHistory : [...priorHistory, { quotedAt: now, rateInclVat: rate, mealBasis: input.finalQuotedMealBasis || quote.pricingGuidanceSnapshot?.proposedRateMealBasis || "UNKNOWN", notes: input.rateNotes || "" }];
  const outcome = { ...input, finalQuotedRateInclVat: rate, decidedAt: input.status === "PENDING" ? null : now, decisionSnapshot: buildQuoteDecisionSnapshot(quote, { ...input, finalQuotedRateInclVat: rate }) };
  await updateQuote(hotelUid, quote.id, { commercialStatus: input.status, outcome, rateHistory });
  if (input.status === "LOST" && input.lostToCompetitorId && Number.isFinite(Number(input.competitorQuotedRateInclVat))) {
    const competitor = (input.competitors || []).find((item) => item.id === input.lostToCompetitorId);
    const publicRatesByDate = (quote.marketContextSnapshot?.stayDates || []).map((night) => ({ stayDate: night.stayDate, publicRateInclVat: night.competitors?.find((item) => item.competitorId === input.lostToCompetitorId)?.publicRateInclVat ?? null })).filter((item) => item.publicRateInclVat !== null);
    const requestedRoomNights = (quote.roomsByDate || []).reduce((sum, night) => sum + Math.max(0, Number(night.rooms) || 0), 0);
    const leadTimeDays = quote.requestDate && quote.startDate ? Math.round((Date.parse(`${quote.startDate}T00:00:00Z`) - Date.parse(`${quote.requestDate}T00:00:00Z`)) / 86400000) : null;
    await saveCompetitorGroupObservation(hotelUid, { competitorId: input.lostToCompetitorId, competitorName: competitor?.displayName || input.lostToCompetitorId, sourceType: "LOST_GROUP", sourceQuoteId: quote.id, observedAt: now, requestDate: quote.requestDate || null, arrivalDate: quote.startDate, checkOutDate: quote.dateRangeSemantics === "CHECKOUT_EXCLUSIVE" ? quote.endDate : null, stayStartDate: quote.startDate, stayEndDate: quote.endDate, roomsByDate: quote.roomsByDate || [], requestedRoomNights, requestedRoomsTotal: requestedRoomNights, leadTimeDays, groupSegment: quote.groupSegment || "UNKNOWN", competitorQuotedRateInclVat: Number(input.competitorQuotedRateInclVat), mealBasis: input.competitorMealBasis || "UNKNOWN", occupancyBasis: input.competitorOccupancyBasis || "UNKNOWN", sourceConfidence: input.competitorSourceConfidence || "LOW", publicRatesByDate, publicRateAtObservationInclVat: publicRatesByDate.length === 1 ? publicRatesByDate[0].publicRateInclVat : null, publicRateMealBasis: "UNKNOWN", notes: input.notes || "" });
  }
  return outcome;
}
