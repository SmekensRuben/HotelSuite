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
