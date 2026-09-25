const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

export function getBrusselsDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function addCalendarDays(dateString, days) {
  if (!DATE_FORMAT.test(dateString)) throw new Error("Invalid date");
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + Number(days))).toISOString().slice(0, 10);
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
  return Object.fromEntries(Object.entries(value).filter(([key, amount]) => key.toLowerCase() !== "total" && typeof amount === "number" && Number.isFinite(amount)));
}

const TOTAL_FIELD_KEYS = new Set(["total", "roomstotal", "totalrooms", "availabilitytotal", "totalavailability"]);

export function extractMappedTotal(data) {
  if (!data || typeof data !== "object") return { value: undefined, field: null };
  const topLevel = Object.entries(data).find(([key]) => TOTAL_FIELD_KEYS.has(key.replace(/[^a-z0-9]/gi, "").toLowerCase()));
  if (topLevel) return { value: topLevel[1], field: topLevel[0] };
  const roomsTotal = Object.entries(data.roomsByType || {}).find(([key]) => key.toLowerCase() === "total");
  return roomsTotal ? { value: roomsTotal[1], field: `roomsByType.${roomsTotal[0]}` } : { value: undefined, field: null };
}

export const createEmptyMarshaBalanceSettings = () => ({
  minimumGenr: 0,
  premiumCategories: [],
  weekendDbdbProtection: true,
});

export function validateBalanceSettings(settings) {
  const errors = [];
  if (!Number.isInteger(Number(settings.minimumGenr)) || Number(settings.minimumGenr) < 0) errors.push("Desired minimum GENR must be a non-negative integer.");
  const seen = new Set();
  (settings.premiumCategories || []).forEach((category) => {
    const marshaCode = String(category.marshaCode || "").trim().toUpperCase();
    const operaType = String(category.operaType || "").trim().toUpperCase();
    if (!marshaCode || !operaType) errors.push("Every premium control needs a MARSHA category and its corresponding Opera room type.");
    if (seen.has(marshaCode)) errors.push(`MARSHA premium category ${marshaCode} is configured more than once.`);
    seen.add(marshaCode);
    if ((category.allowedHigherOperaTypes || []).includes(operaType)) errors.push(`${marshaCode}: the own Opera type cannot also be a higher type.`);
  });
  return [...new Set(errors)];
}

export function isWeekendStayDate(stayDate) {
  if (!DATE_FORMAT.test(stayDate)) return false;
  const [year, month, day] = stayDate.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 5 || weekday === 6;
}

function isReliableCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function alert(severity, code, title, message, details = {}) {
  return { severity, code, title, message, ...details };
}

export function evaluateSimplifiedBalance({ marshaRooms, operaRooms, marshaTotal, operaTotal, settings, stayDate }) {
  const configurationErrors = validateBalanceSettings(settings);
  if (configurationErrors.length) return { code: "unconfigured", label: "Not configured", alerts: configurationErrors.map((message) => alert("unconfigured", "configuration", "Configuration required", message)), categories: [], isWeekend: isWeekendStayDate(stayDate) };

  const alerts = [];
  const categories = [];
  const weekend = isWeekendStayDate(stayDate);
  const totalsReliable = isReliableCount(marshaTotal) && isReliableCount(operaTotal);
  if (!totalsReliable) {
    alerts.push(alert("unassessable", "total_data", "Cannot assess", "Both explicitly mapped total fields must contain reliable non-negative numbers.", { marshaTotal, operaTotal }));
  } else if (marshaTotal !== operaTotal) {
    alerts.push(alert("action", "total_mismatch", "Total mismatch", `MARSHA total is ${marshaTotal}, Opera total is ${operaTotal}; difference ${marshaTotal - operaTotal}.`, { marshaTotal, operaTotal, difference: marshaTotal - operaTotal }));
  }

  const marshaGenr = marshaRooms.GENR;
  let weekendMaximumGenr = null;
  let minimumGenr = totalsReliable ? Math.min(Number(settings.minimumGenr), marshaTotal) : null;
  if (!isReliableCount(marshaGenr)) alerts.push(alert("unreliable", "genr_data", "Cannot reliably assess GENR", "MARSHA GENR is missing, non-numeric, or negative.", { marshaGenr }));

  if (weekend) {
    const operaDbdb = operaRooms.DBDB;
    if (!totalsReliable || marshaTotal !== operaTotal || !isReliableCount(operaDbdb) || !isReliableCount(marshaGenr)) {
      minimumGenr = null;
      alerts.push(alert("unreliable", "weekend_data", "Cannot reliably assess weekend DBDB protection", "Matching reliable totals, Opera DBDB, and MARSHA GENR are required before calculating a weekend boundary.", { marshaTotal, operaTotal, operaDbdb, marshaGenr }));
    } else {
      weekendMaximumGenr = operaTotal - operaDbdb;
      if (weekendMaximumGenr < 0) {
        minimumGenr = null;
        alerts.push(alert("unreliable", "weekend_data", "Cannot reliably assess weekend DBDB protection", "Opera DBDB is greater than the explicit Opera total.", { operaTotal, operaDbdb }));
        weekendMaximumGenr = null;
      } else {
        minimumGenr = Math.min(Number(settings.minimumGenr), marshaTotal, weekendMaximumGenr);
        if (marshaGenr > weekendMaximumGenr) alerts.push(alert("action", "weekend_limit", "Action required", `MARSHA GENR exceeds the Friday/Saturday DBDB protection boundary by ${marshaGenr - weekendMaximumGenr}.`, { operaTotal, operaDbdb, weekendMaximumGenr, marshaGenr, excess: marshaGenr - weekendMaximumGenr }));
      }
    }
  }

  if (minimumGenr !== null && isReliableCount(marshaGenr) && marshaGenr < minimumGenr) alerts.push(alert("warning", "genr_minimum", "GENR minimum warning", `Desired effective GENR is ${minimumGenr}, while MARSHA GENR is ${marshaGenr}.`, { configuredMinimumGenr: Number(settings.minimumGenr), minimumGenr, marshaGenr }));

  const higherTypeUse = new Map();
  (settings.premiumCategories || []).forEach((category) => {
    const marshaCode = category.marshaCode.trim().toUpperCase();
    const operaType = category.operaType.trim().toUpperCase();
    const higherTypes = [...new Set((category.allowedHigherOperaTypes || []).map((code) => String(code).trim().toUpperCase()).filter(Boolean))];
    const marshaValue = marshaRooms[marshaCode];
    const ownOperaValue = operaRooms[operaType];
    const values = higherTypes.map((code) => ({ code, value: operaRooms[code] }));
    if (!isReliableCount(marshaValue) || !isReliableCount(ownOperaValue) || values.some((item) => !isReliableCount(item.value))) {
      const result = { categoryCode: marshaCode, code: "unreliable", label: "Cannot reliably assess", marshaValue, operaType, ownOperaValue, higherTypes: values, reason: "A relevant premium or higher-room value is missing, non-numeric, or negative." };
      categories.push(result); alerts.push(alert("unreliable", "premium_data", `${marshaCode}: Cannot reliably assess`, result.reason, result)); return;
    }
    const shortage = Math.max(0, marshaValue - ownOperaValue);
    if (shortage === 0) { categories.push({ categoryCode: marshaCode, code: "ok", label: marshaValue === 0 ? "Closed without issue" : "No own-type shortage", marshaValue, operaType, ownOperaValue, shortage: 0, higherTypes: values, higherAvailable: values.reduce((sum, item) => sum + item.value, 0), coveredByHigher: 0, uncovered: 0 }); return; }
    const higherAvailable = values.reduce((sum, item) => sum + item.value, 0);
    const coveredByHigher = Math.min(shortage, higherAvailable);
    const uncovered = shortage - coveredByHigher;
    values.forEach((item) => { if (item.value > 0) higherTypeUse.set(item.code, [...(higherTypeUse.get(item.code) || []), marshaCode]); });
    const result = { categoryCode: marshaCode, code: uncovered > 0 ? "action" : "warning", label: uncovered > 0 ? "Action required" : "Upgrade may be required", marshaValue, operaType, ownOperaValue, shortage, higherTypes: values, higherAvailable, coveredByHigher, uncovered };
    categories.push(result);
    alerts.push(alert(uncovered > 0 ? "action" : "warning", uncovered > 0 ? "premium_uncovered" : "premium_upgrade", `${marshaCode}: ${result.label}`, uncovered > 0 ? `${uncovered} offered ${marshaCode} room(s) remain uncovered after ${coveredByHigher} of ${shortage} shortage room(s) can use configured higher types.` : `All ${shortage} shortage room(s) can use configured higher types, so an upgrade may be required.`, result));
  });

  const sharedTypes = [...higherTypeUse.entries()].filter(([, categoryCodes]) => new Set(categoryCodes).size > 1);
  sharedTypes.forEach(([roomType, categoryCodes]) => alerts.push(alert("review", "shared_upgrade", "Review shared upgrade inventory", `${roomType} is available as upgrade inventory for multiple categories (${[...new Set(categoryCodes)].join(", ")}) and is not guaranteed independently to each.`, { roomType, categoryCodes: [...new Set(categoryCodes)] })));

  const priority = { unassessable: 6, unreliable: 5, action: 4, review: 3, warning: 2, ok: 1 };
  const worst = alerts.reduce((current, item) => priority[item.severity] > priority[current] ? item.severity : current, "ok");
  const labels = { unassessable: "Cannot assess", unreliable: "Cannot reliably assess", action: "Action required", review: "Review", warning: "Warning", ok: "Within rules" };
  return { code: worst, label: labels[worst], alerts, categories, marshaTotal, operaTotal, marshaGenr, minimumGenr, weekendMaximumGenr, isWeekend: weekend };
}

export function getSourceState({ stayDocument, snapshotDate, today, metadata = {} }) {
  if (snapshotDate > today) return { status: "expected", label: "Expected" };
  if (!stayDocument) return { status: snapshotDate === today ? "expected" : "missing", label: snapshotDate === today ? "Expected" : "Missing" };
  const completion = String(metadata.status || metadata.importStatus || "").toLowerCase();
  if (["failed", "error", "incomplete"].includes(completion)) return { status: "missing", label: "Missing" };
  if (snapshotDate < today) return { status: "stale", label: "Outdated" };
  return { status: "current", label: "Available and current" };
}
