const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Formats an exact hotel stay-date key without allowing the browser timezone to move it. */
export function formatHotelStayDate(value, locale = "en-GB", options = {}) {
  if (!DATE_KEY.test(String(value || ""))) return "—";
  const [year, month, day] = value.split("-").map(Number);
  const parts = new Intl.DateTimeFormat(locale, {
    weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC", ...options,
  }).formatToParts(new Date(Date.UTC(year, month - 1, day)));
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("weekday")} ${part("day")} ${part("month").replace("Sept", "Sep")} ${part("year")}`;
}

export const SOURCE_DATA_STATUS = Object.freeze({ AVAILABLE: "AVAILABLE", OUT_OF_HORIZON: "OUT_OF_HORIZON", MISSING: "MISSING" });

export function deriveSourceCoverage(snapshotDate, byDate = {}) {
  const dates = Object.keys(byDate).filter((date) => DATE_KEY.test(date)).sort();
  return { snapshotDate: snapshotDate || null, minimumStayDateAvailable: dates[0] || null, maximumStayDateAvailable: dates.at(-1) || null };
}

export function sourceStatusForDate(date, coverage, row, usable = (value) => value != null) {
  if ((coverage.minimumStayDateAvailable && date < coverage.minimumStayDateAvailable) || (coverage.maximumStayDateAvailable && date > coverage.maximumStayDateAvailable)) return SOURCE_DATA_STATUS.OUT_OF_HORIZON;
  return usable(row) ? SOURCE_DATA_STATUS.AVAILABLE : SOURCE_DATA_STATUS.MISSING;
}
