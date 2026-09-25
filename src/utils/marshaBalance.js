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
  availabilityRules: [],
  premiumCategories: [],
});

export function migrateMarshaBalanceSettings(raw = {}) {
  if (Array.isArray(raw.availabilityRules)) return { ...createEmptyMarshaBalanceSettings(), ...raw };
  const hadLegacyGenr = raw.minimumGenr !== undefined || raw.weekendDbdbProtection !== undefined;
  return {
    availabilityRules: hadLegacyGenr ? [{
      marshaCode: "GENR",
      normalMinimum: Math.max(0, Number(raw.minimumGenr) || 0),
      visibilityMinimum: null,
      distributionStopsAtZeroConfirmed: false,
      operaTypeRules: raw.weekendDbdbProtection === false ? [] : [{
        operaType: "DBDB",
        defaultCounts: true,
        weekdayOverrides: { 5: false, 6: false },
        dateOverrides: [],
        independentPhysicalInventoryConfirmed: true,
      }],
    }] : [],
    premiumCategories: Array.isArray(raw.premiumCategories) ? raw.premiumCategories : [],
  };
}

function dateRangesOverlap(first, second) {
  return first.startDate <= second.endDate && second.startDate <= first.endDate;
}

export function validateBalanceSettings(settings) {
  const errors = [];
  const seen = new Set();
  (settings.availabilityRules || []).forEach((rule) => {
    const code = String(rule.marshaCode || "").trim().toUpperCase();
    if (!code) errors.push("Every availability rule needs a MARSHA room type.");
    if (seen.has(code)) errors.push(`MARSHA room type ${code} is configured more than once.`);
    seen.add(code);
    if (!Number.isInteger(Number(rule.normalMinimum)) || Number(rule.normalMinimum) < 0) errors.push(`${code}: normal minimum must be a non-negative integer.`);
    if (rule.visibilityMinimum !== null && rule.visibilityMinimum !== "" && (!Number.isInteger(Number(rule.visibilityMinimum)) || Number(rule.visibilityMinimum) < 1)) errors.push(`${code}: visible minimum must be blank or a positive integer.`);
    (rule.operaTypeRules || []).forEach((operaRule) => {
      if (!String(operaRule.operaType || "").trim()) errors.push(`${code}: every Opera counting rule needs a room type.`);
      const periods = operaRule.dateOverrides || [];
      periods.forEach((period, index) => {
        if (!DATE_FORMAT.test(period.startDate || "") || !DATE_FORMAT.test(period.endDate || "") || period.startDate > period.endDate) errors.push(`${code}/${operaRule.operaType}: date overrides need a valid inclusive start and end date.`);
        if (periods.slice(index + 1).some((other) => dateRangesOverlap(period, other))) errors.push(`${code}/${operaRule.operaType}: overlapping date overrides are not allowed.`);
      });
    });
  });
  const premiumSeen = new Set();
  (settings.premiumCategories || []).forEach((category) => {
    const marshaCode = String(category.marshaCode || "").trim().toUpperCase();
    const operaType = String(category.operaType || "").trim().toUpperCase();
    if (!marshaCode || !operaType) errors.push("Every premium control needs a MARSHA category and its corresponding Opera room type.");
    if (premiumSeen.has(marshaCode)) errors.push(`MARSHA premium category ${marshaCode} is configured more than once.`);
    premiumSeen.add(marshaCode);
    if ((category.allowedHigherOperaTypes || []).includes(operaType)) errors.push(`${marshaCode}: the own Opera type cannot also be a higher type.`);
  });
  return [...new Set(errors)];
}

export function getStayDateWeekday(stayDate) {
  if (!DATE_FORMAT.test(stayDate)) return null;
  const [year, month, day] = stayDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function resolveOperaCountingRule(rule, stayDate) {
  const dateOverride = (rule.dateOverrides || []).find((item) => item.startDate <= stayDate && stayDate <= item.endDate);
  if (dateOverride) return { counts: Boolean(dateOverride.counts), source: "date", description: `${dateOverride.startDate} through ${dateOverride.endDate} (inclusive)` };
  const weekday = getStayDateWeekday(stayDate);
  if (rule.weekdayOverrides && Object.prototype.hasOwnProperty.call(rule.weekdayOverrides, weekday)) return { counts: Boolean(rule.weekdayOverrides[weekday]), source: "weekday", description: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday] };
  return { counts: Boolean(rule.defaultCounts), source: "default", description: "Default" };
}

function isReliableCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function alert(severity, code, title, message, details = {}) {
  return { ...details, severity, code, title, message };
}

export function evaluateSimplifiedBalance({ marshaRooms, operaRooms, marshaTotal, operaTotal, settings, stayDate }) {
  const migrated = migrateMarshaBalanceSettings(settings);
  const configurationErrors = validateBalanceSettings(migrated);
  if (configurationErrors.length) return { code: "unconfigured", label: "Not configured", alerts: configurationErrors.map((message) => alert("unconfigured", "configuration", "Configuration required", message)), categories: [], availabilityAssessments: [] };
  const alerts = [];
  const categories = [];
  const availabilityAssessments = [];
  const totalsReliable = isReliableCount(marshaTotal) && isReliableCount(operaTotal);
  if (!totalsReliable) alerts.push(alert("unassessable", "total_data", "Cannot assess", "Both explicitly mapped total fields must contain reliable non-negative numbers.", { marshaTotal, operaTotal }));
  else if (marshaTotal !== operaTotal) alerts.push(alert("action", "total_mismatch", "Total mismatch", `MARSHA total is ${marshaTotal}, Opera total is ${operaTotal}; difference ${marshaTotal - operaTotal}.`, { marshaTotal, operaTotal, difference: marshaTotal - operaTotal }));

  (migrated.availabilityRules || []).forEach((rule) => {
    const marshaCode = rule.marshaCode.trim().toUpperCase();
    const marshaValue = marshaRooms[marshaCode];
    const appliedOperaRules = (rule.operaTypeRules || []).map((operaRule) => ({ ...operaRule, operaType: operaRule.operaType.trim().toUpperCase(), applied: resolveOperaCountingRule(operaRule, stayDate), value: operaRooms[operaRule.operaType.trim().toUpperCase()] }));
    const excluded = appliedOperaRules.filter((item) => !item.applied.counts);
    const included = appliedOperaRules.filter((item) => item.applied.counts);
    const assessment = { marshaCode, marshaValue, normalMinimum: Number(rule.normalMinimum), visibilityMinimum: rule.visibilityMinimum === null || rule.visibilityMinimum === "" ? null : Number(rule.visibilityMinimum), distributionStopsAtZeroConfirmed: Boolean(rule.distributionStopsAtZeroConfirmed), appliedOperaRules, excludedOperaTypes: excluded.map((item) => ({ code: item.operaType, value: item.value, rule: item.applied })) };
    if (!isReliableCount(marshaValue)) {
      alerts.push(alert("unreliable", "availability_data", `${marshaCode}: Cannot reliably assess`, `${marshaCode} is missing, non-numeric, or negative.`, assessment));
      availabilityAssessments.push({ ...assessment, code: "unreliable" }); return;
    }
    if (!totalsReliable) { availabilityAssessments.push({ ...assessment, code: "unassessable" }); return; }
    if (excluded.some((item) => !isReliableCount(item.value) || !item.independentPhysicalInventoryConfirmed)) {
      alerts.push(alert("unreliable", "excluded_inventory_data", `${marshaCode}: Cannot reliably assess excluded inventory`, "Every excluded Opera type needs a reliable non-negative value and confirmation that it is independent physical inventory.", assessment));
      availabilityAssessments.push({ ...assessment, code: "unreliable" }); return;
    }
    if (included.some((item) => !isReliableCount(item.value))) {
      alerts.push(alert("unreliable", "included_inventory_data", `${marshaCode}: Cannot reliably assess suitable inventory`, "Every included Opera type needs a reliable non-negative value.", assessment));
      availabilityAssessments.push({ ...assessment, code: "unreliable" }); return;
    }
    const excludedTotal = excluded.reduce((sum, item) => sum + item.value, 0);
    const suitableInventory = operaTotal - excludedTotal;
    const suitableRoomAvailable = included.some((item) => item.value > 0 && item.independentPhysicalInventoryConfirmed);
    Object.assign(assessment, { excludedTotal, suitableInventory, suitableRoomAvailable });
    if (suitableInventory < 0) {
      alerts.push(alert("unreliable", "suitable_inventory_data", `${marshaCode}: Cannot reliably assess suitable inventory`, "Excluded independent inventory is greater than the explicit Opera total.", assessment));
      availabilityAssessments.push({ ...assessment, code: "unreliable" }); return;
    }
    // Excluded/protected inventory always has priority over a low-total visibility exception.
    if (excluded.length > 0 && marshaValue > suitableInventory) alerts.push(alert("action", "suitable_inventory_limit", `${marshaCode}: Action required`, `${marshaCode} exceeds demonstrably suitable inventory by ${marshaValue - suitableInventory}.`, { ...assessment, excess: marshaValue - suitableInventory }));
    if (marshaTotal === 0) {
      if (marshaValue > 0) alerts.push(alert("action", "zero_total_visibility", `${marshaCode}: Action required`, `MARSHA total is 0 but ${marshaCode} still shows ${marshaValue}.`, assessment));
      availabilityAssessments.push({ ...assessment, effectiveMinimum: 0, code: marshaValue > 0 ? "action" : "ok" }); return;
    }
    const normalMinimum = Math.min(Number(rule.normalMinimum), marshaTotal);
    let effectiveMinimum = normalMinimum;
    const lowTotalVisibility = assessment.visibilityMinimum !== null && marshaTotal < assessment.visibilityMinimum;
    if (lowTotalVisibility) effectiveMinimum = assessment.visibilityMinimum;
    if (lowTotalVisibility && marshaValue > marshaTotal) {
      if (!suitableRoomAvailable || !rule.distributionStopsAtZeroConfirmed) alerts.push(alert("review", "visibility_exception_review", `${marshaCode}: Review visibility exception`, !suitableRoomAvailable ? "Availability above the hotel total has no confirmed suitable Opera room available." : "Distribution stop-at-zero behavior is not confirmed, so availability above the hotel total is not presented as safe.", { ...assessment, effectiveMinimum }));
    }
    if (marshaValue < effectiveMinimum) alerts.push(alert("warning", "availability_minimum", `${marshaCode}: Minimum warning`, `Effective minimum is ${effectiveMinimum}, while MARSHA shows ${marshaValue}.`, { ...assessment, effectiveMinimum }));
    availabilityAssessments.push({ ...assessment, effectiveMinimum, lowTotalVisibility, code: "ok" });
  });

  const higherTypeUse = new Map();
  (migrated.premiumCategories || []).forEach((category) => {
    const marshaCode = category.marshaCode.trim().toUpperCase();
    const operaType = category.operaType.trim().toUpperCase();
    const higherTypes = [...new Set((category.allowedHigherOperaTypes || []).map((code) => String(code).trim().toUpperCase()).filter(Boolean))];
    const marshaValue = marshaRooms[marshaCode];
    const ownOperaValue = operaRooms[operaType];
    const values = higherTypes.map((code) => ({ code, value: operaRooms[code] }));
    if (!isReliableCount(marshaValue) || !isReliableCount(ownOperaValue) || values.some((item) => !isReliableCount(item.value))) { const result = { categoryCode: marshaCode, code: "unreliable", label: "Cannot reliably assess", marshaValue, operaType, ownOperaValue, higherTypes: values }; categories.push(result); alerts.push(alert("unreliable", "premium_data", `${marshaCode}: Cannot reliably assess`, "A relevant premium or higher-room value is missing, non-numeric, or negative.", result)); return; }
    const shortage = Math.max(0, marshaValue - ownOperaValue);
    if (!shortage) { categories.push({ categoryCode: marshaCode, code: "ok", label: "No own-type shortage", marshaValue, operaType, ownOperaValue, shortage: 0, higherTypes: values, coveredByHigher: 0, uncovered: 0 }); return; }
    const higherAvailable = values.reduce((sum, item) => sum + item.value, 0);
    const coveredByHigher = Math.min(shortage, higherAvailable);
    const uncovered = shortage - coveredByHigher;
    values.forEach((item) => { if (item.value > 0) higherTypeUse.set(item.code, [...(higherTypeUse.get(item.code) || []), marshaCode]); });
    const result = { categoryCode: marshaCode, code: uncovered ? "action" : "warning", label: uncovered ? "Action required" : "Upgrade may be required", marshaValue, operaType, ownOperaValue, shortage, higherTypes: values, coveredByHigher, uncovered };
    categories.push(result); alerts.push(alert(uncovered ? "action" : "warning", uncovered ? "premium_uncovered" : "premium_upgrade", `${marshaCode}: ${result.label}`, uncovered ? `${uncovered} offered room(s) remain uncovered.` : `All ${shortage} shortage room(s) can use configured higher types.`, result));
  });
  [...higherTypeUse.entries()].filter(([, codes]) => new Set(codes).size > 1).forEach(([roomType, codes]) => alerts.push(alert("review", "shared_upgrade", "Review shared upgrade inventory", `${roomType} is open to multiple categories (${[...new Set(codes)].join(", ")}).`, { roomType })));
  const priority = { unassessable: 7, unreliable: 6, action: 5, review: 4, warning: 3, unconfigured: 2, ok: 1 };
  const worst = alerts.reduce((current, item) => priority[item.severity] > priority[current] ? item.severity : current, "ok");
  const labels = { unassessable: "Cannot assess", unreliable: "Cannot reliably assess", action: "Action required", review: "Review", warning: "Warning", ok: "Within rules" };
  return { code: worst, label: labels[worst], alerts, categories, availabilityAssessments, marshaTotal, operaTotal };
}

export function getSourceState({ stayDocument, snapshotDate, today, metadata = {} }) {
  if (snapshotDate > today) return { status: "expected", label: "Expected" };
  if (!stayDocument) return { status: snapshotDate === today ? "expected" : "missing", label: snapshotDate === today ? "Expected" : "Missing" };
  const completion = String(metadata.status || metadata.importStatus || "").toLowerCase();
  if (["failed", "error", "incomplete"].includes(completion)) return { status: "missing", label: "Missing" };
  if (snapshotDate < today) return { status: "stale", label: "Outdated" };
  return { status: "current", label: "Available and current" };
}
