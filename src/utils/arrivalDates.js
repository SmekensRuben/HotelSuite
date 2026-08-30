const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDateKey(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return null;
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null;
}

export function calculateNights(arrivalDate, departureDate) {
  const arrival = parseDateKey(arrivalDate);
  const departure = parseDateKey(departureDate);
  if (!arrival || !departure || departure < arrival) return "";
  return Math.round((departure - arrival) / MILLISECONDS_PER_DAY);
}

