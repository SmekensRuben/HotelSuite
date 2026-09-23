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
  if (!DATE_FORMAT.test(dateString)) throw new Error("Invalid date");
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
  rules.filter((rule) => rule.enabled && rule.ruleScope !== "total").forEach((rule) => {
    (rule.operaRoomTypes || []).forEach((type) => {
      const normalized = String(type).trim();
      if (!normalized) return;
      if (owner.has(normalized) && owner.get(normalized) !== rule.id) overlaps.add(normalized);
      owner.set(normalized, rule.id);
    });
  });
  return [...overlaps];
}

function getPhysicalRoomTotal(rooms) {
  return Object.entries(rooms).reduce((sum, [type, value]) => (
    type.toLowerCase() === "total" ? sum : sum + Math.max(0, value)
  ), 0);
}

export function isBalanceRuleApplicable(rule, marshaRooms, operaRooms) {
  const condition = rule.activationCondition || "always";
  if (condition === "always") return true;
  const rooms = rule.activationSource === "opera" ? operaRooms : marshaRooms;
  const total = getPhysicalRoomTotal(rooms);
  const threshold = Number(rule.activationThreshold) || 0;
  return condition === "totalAbove" ? total > threshold : total < threshold;
}

export function evaluateBalance(marshaRooms, operaRooms, rules) {
  const activeRules = (rules || []).filter((rule) => rule.enabled);
  if (!activeRules.length) return { status: "unconfigured", label: "No rules configured", calculations: [] };
  const overlaps = findOverlappingOperaTypes(activeRules);
  if (overlaps.length) return { status: "unassessable", label: "Cannot assess", reason: `Opera room type used more than once: ${overlaps.join(", ")}`, calculations: [] };

  const calculations = activeRules.map((rule) => {
    const applicable = isBalanceRuleApplicable(rule, marshaRooms, operaRooms);
    if (!applicable) return { rule, applicable: false, assessable: true, within: true, violation: 0 };
    const isTotalRule = rule.ruleScope === "total";
    const marshaPresent = isTotalRule || Object.prototype.hasOwnProperty.call(marshaRooms, rule.marshaRoomType);
    const missingOperaTypes = isTotalRule ? [] : (rule.operaRoomTypes || []).filter((type) => !Object.prototype.hasOwnProperty.call(operaRooms, type));
    if (!marshaPresent || missingOperaTypes.length) return { rule, assessable: false, missingOperaTypes, marshaPresent };
    const marshaValue = isTotalRule
      ? Object.entries(marshaRooms).reduce((sum, [type, value]) => type.toLowerCase() === "total" ? sum : sum + value, 0)
      : Math.max(0, marshaRooms[rule.marshaRoomType]);
    const operaValue = isTotalRule
      ? Object.entries(operaRooms).reduce((sum, [type, value]) => type.toLowerCase() === "total" ? sum : sum + value, 0)
      : rule.operaRoomTypes.reduce((sum, type) => sum + Math.max(0, operaRooms[type]), 0);
    const reservedRooms = Number(rule.reservedRooms) || 0;
    const comparedOperaValue = operaValue - reservedRooms;
    const difference = comparedOperaValue - marshaValue;
    const tolerance = Math.max(0, Number(rule.allowedDeviation) || 0);
    const mode = rule.comparisonMode || "exact";
    const within = mode === "upper"
      ? difference <= tolerance
      : mode === "lower"
        ? difference >= -tolerance
      : mode === "range"
        ? difference >= -(Number(rule.lowerDeviation) || tolerance) && difference <= (Number(rule.upperDeviation) || tolerance)
        : Math.abs(difference) <= tolerance;
    const violation = mode === "upper"
      ? Math.max(0, difference - tolerance)
      : mode === "lower"
        ? Math.max(0, -difference - tolerance)
        : mode === "range"
          ? Math.max(0, -(Number(rule.lowerDeviation) || tolerance) - difference, difference - (Number(rule.upperDeviation) || tolerance))
          : Math.max(0, Math.abs(difference) - tolerance);
    return { rule, applicable: true, assessable: true, marshaValue, operaValue, reservedRooms, comparedOperaValue, difference, tolerance, within, violation };
  });
  const applicableCalculations = calculations.filter((item) => item.applicable !== false);
  if (!applicableCalculations.length) return { status: "ok", label: "No applicable rules", calculations };
  if (applicableCalculations.some((item) => !item.assessable)) return { status: "unassessable", label: "Cannot assess", calculations };
  const worstDifference = Math.max(...applicableCalculations.map((item) => item.violation));
  if (applicableCalculations.every((item) => item.within)) return { status: "ok", label: "Balanced", calculations };
  if (worstDifference <= 2) return { status: "review", label: "Review", calculations };
  return { status: "critical", label: "Critical", calculations };
}

export function getSourceState({ stayDocument, snapshotDate, today, metadata = {} }) {
  if (snapshotDate > today) return { status: "expected", label: "Expected" };
  if (!stayDocument) return { status: snapshotDate === today ? "expected" : "missing", label: snapshotDate === today ? "Expected" : "Missing" };
  const completion = String(metadata.status || metadata.importStatus || "").toLowerCase();
  if (["failed", "error", "incomplete"].includes(completion)) return { status: "missing", label: "Missing" };
  if (snapshotDate < today) return { status: "stale", label: "Outdated" };
  return { status: "current", label: "Available and current" };
}
