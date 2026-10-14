export function orderPriceReliability(line) {
  const basis = line.pricingDateBasis === "delivery-date" ? "delivery date" : "order date";
  const date = line.pricingDate || "date unavailable";
  if (!Object.hasOwn(line, "priceValidity")) return "Historical price snapshot; validity was not recorded.";
  const validity = line.priceValidity === "current" ? "Approved price" : line.priceValidity === "unknown" ? "Validity unknown" : "Price needs review";
  return `${validity} · ${basis}: ${date}${line.pricingAgreementKnown === false ? " · supplier date agreement needs review" : line.priceNeedsReview ? " · source evidence needs review" : ""}`;
}

export function orderPriceSource(line) {
  const source = line.priceSourceReference;
  if (typeof source === "string" && source) {
    const confirmation = line.priceConfirmationSourceReference;
    return `Source: ${source}${typeof confirmation === "string" && confirmation && confirmation !== source ? ` · Last confirmation: ${confirmation}` : ""}`;
  }
  if (source && typeof source === "object") {
    const label = source.fileName || source.filename || source.label || source.importJobId || source.jobId;
    if (typeof label === "string" && label) return `Source: ${label}`;
  }
  return "Source not recorded";
}

function evidenceDate(value) {
  if (!value) return "unknown";
  let date;
  if (typeof value?.toDate === "function") date = value.toDate();
  else if (value instanceof Date) date = value;
  else if (typeof value === "object" && Number.isFinite(value.seconds ?? value._seconds)) date = new Date((value.seconds ?? value._seconds) * 1000);
  else if (typeof value === "string") date = new Date(value);
  return date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "unknown";
}

export function orderPriceEvidence(line) {
  return `Price changed: ${evidenceDate(line.lastPriceChangeAt)} · Last confirmed: ${evidenceDate(line.lastPriceConfirmedAt)}${line.priceConfirmationMatchesCurrentTerms === false && line.lastPriceConfirmedAt ? " (previous terms)" : ""}`;
}
