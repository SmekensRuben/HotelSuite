export function catalogLocationDraft(location) {
  const saved = location.countedItems || [];
  const templateIds = new Set((location.stockTemplate?.items || []).map((item) => item.catalogProductId));
  return {
    additional: saved.filter((item) => !templateIds.has(item.catalogProductId)),
    quantities: Object.fromEntries(saved.map((item) => [item.catalogProductId, item.isCounted === false ? "" : String(item.quantity ?? "")])),
    costs: Object.fromEntries(saved.map((item) => [item.catalogProductId, item.unitCost == null ? "" : String(item.unitCost)])),
    appliedEstimateIds: [],
  };
}

export function validCatalogDraft(value) {
  const entries = (map) => map && typeof map === "object" && !Array.isArray(map)
    && Object.keys(map).length <= 250 && Object.values(map).every((entry) => typeof entry === "string");
  return value && Array.isArray(value.additional) && value.additional.length <= 250
    && value.additional.every((item) => typeof item?.catalogProductId === "string" && item.catalogProductId)
    && entries(value.quantities) && entries(value.costs)
    && Array.isArray(value.appliedEstimateIds) && value.appliedEstimateIds.every((id) => typeof id === "string");
}

// Every differing row requires an explicit choice. Newly included rows from
// either editor remain included; quantities are never added together.
export function reviewCatalogDraft(location, draftRows, draft) {
  const saved = catalogLocationDraft(location);
  const savedRows = [...(location.stockTemplate?.items || []), ...saved.additional];
  const savedIds = new Set(savedRows.map((item) => item.catalogProductId));
  const mineIds = new Set(draftRows.map((item) => item.catalogProductId));
  const rows = [...new Map([...draftRows, ...savedRows].map((item) => [item.catalogProductId, item])).values()];
  return rows.map((item) => {
    const id = item.catalogProductId;
    const mine = { quantity: draft.quantities[id] ?? "", cost: draft.costs[id] ?? "" };
    const theirs = { quantity: saved.quantities[id] ?? "", cost: saved.costs[id] ?? "" };
    const differs = savedIds.has(id) && mineIds.has(id) && (mine.quantity !== theirs.quantity || mine.cost !== theirs.cost);
    return { item, mine, theirs, differs, defaultChoice: mineIds.has(id) ? "mine" : "saved" };
  });
}

export function resolveCatalogDraft(location, review, choices) {
  const templateIds = new Set((location.stockTemplate?.items || []).map((item) => item.catalogProductId));
  const result = { additional: [], quantities: {}, costs: {}, appliedEstimateIds: [] };
  for (const row of review) {
    const id = row.item.catalogProductId, choice = row.differs ? choices[id] : row.defaultChoice;
    if (!["mine", "saved"].includes(choice)) throw new Error("Choose a count for every changed article before continuing.");
    const value = choice === "mine" ? row.mine : row.theirs;
    if (!templateIds.has(id)) result.additional.push(row.item);
    result.quantities[id] = value.quantity; result.costs[id] = value.cost;
  }
  return result;
}
