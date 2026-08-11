const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDateKey(value) {
  const raw = String(value || "").trim();
  if (!DATE_KEY_PATTERN.test(raw)) return null;

  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;

  return date;
}

function normalizeDeadlineDays(value) {
  if (value === "" || value === null || value === undefined) return null;
  const days = Number(value);
  return Number.isInteger(days) && days >= 0 ? days : null;
}

export function calculateRoomingListDeadline(arrival, deadlineDays) {
  const arrivalDate = parseDateKey(arrival);
  const days = normalizeDeadlineDays(deadlineDays);
  if (!arrivalDate || days === null) return "";

  arrivalDate.setUTCDate(arrivalDate.getUTCDate() - days);
  return arrivalDate.toISOString().slice(0, 10);
}

export function getRoomingListDeadlineDays(group) {
  const savedDays = normalizeDeadlineDays(group?.roomingListDeadlineDays);
  if (savedDays !== null) return savedDays;

  // Support groups created before the deadline was stored as a number of days.
  const arrival = parseDateKey(group?.arrival);
  const deadline = parseDateKey(group?.roomingListDeadline);
  if (!arrival || !deadline) return "";

  const days = (arrival.getTime() - deadline.getTime()) / 86400000;
  return Number.isInteger(days) && days >= 0 ? days : "";
}
