const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

export function getBrusselsDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Brussels",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addCalendarDays(dateString, days) {
  if (!DATE_FORMAT.test(dateString)) throw new Error("Ongeldige datum");
  const [year, month, day] = dateString.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + Number(days)));
  return result.toISOString().slice(0, 10);
}

export function getDefaultBalanceRange(now = new Date()) {
  const from = getBrusselsDateString(now);
  return { from, to: addCalendarDays(from, 30) };
}

export function enumerateDates(from, to) {
  if (!DATE_FORMAT.test(from) || !DATE_FORMAT.test(to) || from > to) return [];
  const dates = [];
  for (let value = from; value <= to; value = addCalendarDays(value, 1)) dates.push(value);
  return dates;
}

export function normalizeRoomsByType(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, amount]) =>
    key.toLowerCase() !== "total" && typeof amount === "number" && Number.isFinite(amount)
  ));
}

export function findOverlappingOperaTypes(rules) {
  const owner = new Map();
  const overlaps = new Set();
  rules.filter((rule) => rule.enabled).forEach((rule) => {
    (rule.operaRoomTypes || []).forEach((type) => {
      const normalized = String(type).trim();
      if (!normalized) return;
      if (owner.has(normalized) && owner.get(normalized) !== rule.id) overlaps.add(normalized);
      owner.set(normalized, rule.id);
    });
  });
  return [...overlaps];
}

export function evaluateBalance(marshaRooms, operaRooms, rules) {
  const activeRules = (rules || []).filter((rule) => rule.enabled);
  if (!activeRules.length) return { status: "unconfigured", label: "Geen regels ingesteld", calculations: [] };
  const overlaps = findOverlappingOperaTypes(activeRules);
  if (overlaps.length) return { status: "unassessable", label: "Niet te beoordelen", reason: `Opera-kamertype dubbel gebruikt: ${overlaps.join(", ")}`, calculations: [] };

  const calculations = activeRules.map((rule) => {
    const marshaPresent = Object.prototype.hasOwnProperty.call(marshaRooms, rule.marshaRoomType);
    const missingOperaTypes = (rule.operaRoomTypes || []).filter((type) => !Object.prototype.hasOwnProperty.call(operaRooms, type));
    if (!marshaPresent || missingOperaTypes.length) return { rule, assessable: false, missingOperaTypes, marshaPresent };
    const marshaValue = marshaRooms[rule.marshaRoomType];
    const operaValue = rule.operaRoomTypes.reduce((sum, type) => sum + operaRooms[type], 0);
    const reservedRooms = Number(rule.reservedRooms) || 0;
    const comparedOperaValue = operaValue - reservedRooms;
    const difference = comparedOperaValue - marshaValue;
    const tolerance = Math.max(0, Number(rule.allowedDeviation) || 0);
    const mode = rule.comparisonMode || "exact";
    const within = mode === "upper"
      ? difference <= tolerance
      : mode === "range"
        ? difference >= -(Number(rule.lowerDeviation) || tolerance) && difference <= (Number(rule.upperDeviation) || tolerance)
        : Math.abs(difference) <= tolerance;
    return { rule, assessable: true, marshaValue, operaValue, reservedRooms, comparedOperaValue, difference, tolerance, within };
  });
  if (calculations.some((item) => !item.assessable)) return { status: "unassessable", label: "Niet te beoordelen", calculations };
  const worstDifference = Math.max(...calculations.map((item) => Math.abs(item.difference) - item.tolerance));
  if (calculations.every((item) => item.within)) return { status: "ok", label: "Binnen regels", calculations };
  if (worstDifference <= 2) return { status: "review", label: "Nakijken", calculations };
  return { status: "critical", label: "Kritiek", calculations };
}

export function getSourceState({ stayDocument, snapshotDate, today, metadata = {} }) {
  if (snapshotDate > today) return { status: "expected", label: "Nog verwacht" };
  if (!stayDocument) return { status: snapshotDate === today ? "expected" : "missing", label: snapshotDate === today ? "Nog verwacht" : "Ontbrekend" };
  const completion = String(metadata.status || metadata.importStatus || "").toLowerCase();
  if (["failed", "error", "incomplete"].includes(completion)) return { status: "missing", label: "Ontbrekend" };
  if (snapshotDate < today) return { status: "stale", label: "Verouderd" };
  return { status: "current", label: "Aanwezig en actueel" };
}
