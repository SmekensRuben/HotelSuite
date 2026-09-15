function parseDateInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return null;

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? date : null;
}

export function getInclusiveQuoteDates(startDate, endDate) {
  const start = parseDateInput(startDate);
  const end = parseDateInput(endDate);
  if (!start || !end || end < start) return [];

  const dates = [];
  for (const date = start; date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

export const DATE_RANGE_SEMANTICS = Object.freeze({ LEGACY_INCLUSIVE: "LEGACY_INCLUSIVE", CHECKOUT_EXCLUSIVE: "CHECKOUT_EXCLUSIVE" });

export function getCheckoutExclusiveStayDates(arrivalDate, checkOutDate) {
  const start = parseDateInput(arrivalDate);
  const end = parseDateInput(checkOutDate);
  if (!start || !end || end <= start) return [];
  const dates = [];
  for (const date = start; date < end; date.setUTCDate(date.getUTCDate() + 1)) dates.push(date.toISOString().slice(0, 10));
  return dates;
}

export function getQuoteStayDates(quote = {}) {
  return quote.dateRangeSemantics === DATE_RANGE_SEMANTICS.CHECKOUT_EXCLUSIVE
    ? getCheckoutExclusiveStayDates(quote.startDate, quote.endDate)
    : getInclusiveQuoteDates(quote.startDate, quote.endDate);
}

export function differenceInIsoDays(later, earlier) {
  const end = parseDateInput(later);
  const start = parseDateInput(earlier);
  return end && start ? Math.round((end.getTime() - start.getTime()) / 86400000) : null;
}
