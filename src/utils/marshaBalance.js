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
  return Object.fromEntries(Object.entries(value).filter(([, amount]) => typeof amount === "number" && Number.isFinite(amount)));
}

export const createEmptyMarshaBalanceSettings = () => ({
  operaRoomTypes: [],
  salesCategories: [],
  hotelOverbookingLimit: 0,
  hotelOverbookingConfirmed: false,
  hotelSalesLimit: null,
  hotelSalesLimitConfirmed: false,
  exceptions: [],
});

export function validateBalanceSettings(settings) {
  const errors = [];
  const physical = new Set((settings.operaRoomTypes || []).filter((item) => item.classification === "physical").map((item) => item.code));
  const categoryCodes = new Set();
  (settings.salesCategories || []).forEach((category) => {
    if (!category.code) errors.push("Every sales category needs a MARSHA code.");
    if (categoryCodes.has(category.code)) errors.push(`MARSHA category ${category.code} is configured more than once.`);
    categoryCodes.add(category.code);
    if (category.confirmed && !(category.allowedOperaTypes || []).length) errors.push(`${category.code || "A category"} needs at least one allowed physical Opera type.`);
    (category.allowedOperaTypes || []).forEach((code) => {
      if (!physical.has(code)) errors.push(`${code} is not configured as a physical Opera room type.`);
    });
  });
  return [...new Set(errors)];
}

function activeException(settings, categoryCode, stayDate) {
  return (settings.exceptions || []).find((item) => item.categoryCode === categoryCode && item.startDate <= stayDate && item.endDate >= stayDate && item.reason && item.responsible);
}

function status(label, code, details = {}) {
  return { label, code, ...details };
}

export function evaluateOperationalBalance(marshaRooms, operaRooms, settings, stayDate) {
  const validationErrors = validateBalanceSettings(settings);
  if (validationErrors.length) return { ...status("Not configured", "unconfigured"), reason: validationErrors.join(" "), categories: [], dataIssues: validationErrors };

  const physicalConfig = (settings.operaRoomTypes || []).filter((item) => item.classification === "physical");
  const physicalCodes = new Set(physicalConfig.map((item) => item.code));
  const categories = settings.salesCategories || [];
  const unclassifiedOpera = Object.keys(operaRooms).filter((code) => code.toLowerCase() !== "total" && !(settings.operaRoomTypes || []).some((item) => item.code === code && item.classification && item.classification !== "unclassified"));
  if (unclassifiedOpera.length) return { ...status("Not configured", "unconfigured"), reason: `Opera room types need classification: ${unclassifiedOpera.join(", ")}.`, categories: [], dataIssues: [] };
  const missingConfig = Object.keys(marshaRooms).filter((code) => code.toLowerCase() !== "total" && !categories.some((item) => item.code === code && item.confirmed));
  if (missingConfig.length) return { ...status("Not configured", "unconfigured"), reason: `MARSHA categories need confirmation: ${missingConfig.join(", ")}.`, categories: [], dataIssues: [] };
  if (!physicalConfig.length || !categories.length) return { ...status("Not configured", "unconfigured"), reason: "Physical Opera room types and MARSHA sales categories must be configured.", categories: [], dataIssues: [] };

  const missingOpera = [...physicalCodes].filter((code) => !Object.prototype.hasOwnProperty.call(operaRooms, code));
  if (missingOpera.length) return { ...status("Cannot assess", "unassessable"), reason: `Physical Opera values are missing: ${missingOpera.join(", ")}.`, categories: [], dataIssues: missingOpera };

  const pools = Object.fromEntries(physicalConfig.map((item) => [item.code, Math.max(0, operaRooms[item.code])]));
  const rawOpera = Object.fromEntries(physicalConfig.map((item) => [item.code, operaRooms[item.code]]));
  const protection = Object.fromEntries(physicalConfig.map((item) => [item.code, { count: Math.max(0, Number(item.protectedRooms) || 0), mode: item.protectionMode || "hard" }]));
  const placements = [];
  const deficitIssues = [];

  // A negative value is an existing type deficit. Its category's higher allowed types must absorb it first.
  physicalConfig.filter((item) => operaRooms[item.code] < 0).forEach((item) => {
    let deficit = Math.abs(operaRooms[item.code]);
    const owner = categories.find((category) => category.confirmed && category.allowedOperaTypes?.[0] === item.code);
    if (!owner) {
      deficitIssues.push(`The meaning of ${item.code} ${operaRooms[item.code]} cannot be allocated because no confirmed category owns this type.`);
      return;
    }
    for (const upgradeCode of owner.allowedOperaTypes.slice(1)) {
      const available = Math.max(0, pools[upgradeCode] - (protection[upgradeCode]?.mode === "hard" ? protection[upgradeCode].count : 0));
      const used = Math.min(deficit, available);
      if (used) { pools[upgradeCode] -= used; deficit -= used; placements.push({ categoryCode: owner.code, operaType: upgradeCode, rooms: used, purpose: `cover existing ${item.code} deficit` }); }
    }
    if (deficit) deficitIssues.push(`${deficit} existing ${item.code} deficit cannot be covered by confirmed higher room types.`);
  });
  if (deficitIssues.some((message) => message.includes("meaning"))) return { ...status("Cannot reliably assess", "unreliable"), reason: deficitIssues.join(" "), categories: [], dataIssues: deficitIssues };

  const eligibleByType = {};
  categories.filter((item) => item.confirmed).forEach((category) => (category.allowedOperaTypes || []).forEach((code) => { eligibleByType[code] = [...(eligibleByType[code] || []), category.code]; }));
  let hotelOverbookingRemaining = settings.hotelOverbookingConfirmed ? Math.max(0, Number(settings.hotelOverbookingLimit) || 0) : 0;
  const results = [];

  categories.filter((item) => item.confirmed).forEach((category) => {
    const offeredRaw = marshaRooms[category.code];
    if (offeredRaw === undefined) { results.push({ categoryCode: category.code, ...status("Cannot assess", "unassessable"), reason: "MARSHA value is missing." }); return; }
    const offered = Math.max(0, offeredRaw);
    let remaining = offered;
    let softProtectedUsed = 0;
    let higherUsed = 0;
    const categoryPlacements = [];
    const allowed = category.allowedOperaTypes || [];
    const higherAvailableBeforePlacement = allowed.slice(1).reduce((sum, code) => {
      const protectedSetting = protection[code];
      if (!protectedSetting) return sum;
      return sum + (protectedSetting.mode === "soft" ? pools[code] : Math.max(0, pools[code] - protectedSetting.count));
    }, 0);
    const higherPotential = category.releasePolicy === "early"
      ? Math.min(higherAvailableBeforePlacement, Math.max(0, Number(category.earlyReleaseLimit) || 0))
      : Math.min(higherAvailableBeforePlacement, Math.max(0, offered - (pools[allowed[0]] || 0)));
    allowed.forEach((code, index) => {
      if (!physicalCodes.has(code) || remaining <= 0) return;
      const protectedSetting = protection[code];
      const freelyAvailable = index === 0 ? pools[code] : Math.max(0, pools[code] - protectedSetting.count);
      let usable = freelyAvailable;
      if (index === 0 || protectedSetting.mode === "soft") usable = pools[code];
      const used = Math.min(remaining, usable);
      if (!used) return;
      const protectedUse = Math.max(0, used - freelyAvailable);
      pools[code] -= used; remaining -= used; softProtectedUsed += protectedUse;
      if (index > 0) higherUsed += used;
      categoryPlacements.push({ operaType: code, rooms: used, kind: index === 0 ? "preferred" : "upgrade", protectedUse });
    });
    const exception = activeException(settings, category.code, stayDate);
    const categoryOverbooking = Math.max(0, Number(category.overbookingLimit) || 0) + Math.max(0, Number(exception?.additionalOverbooking) || 0);
    const approvedOverbooking = Math.min(remaining, categoryOverbooking + hotelOverbookingRemaining);
    const fromHotel = Math.max(0, approvedOverbooking - categoryOverbooking);
    hotelOverbookingRemaining -= fromHotel;
    remaining -= approvedOverbooking;
    const sharedTypes = allowed.filter((code) => (eligibleByType[code] || []).some((otherCode) => otherCode !== category.code && Math.max(0, marshaRooms[otherCode] || 0) > 0));
    const sharedRisk = sharedTypes.length > 0 && !settings.hotelSalesLimitConfirmed;
    let result;
    if (remaining > 0 && !sharedRisk) result = status("Action required", "action");
    else if (remaining > 0 || sharedRisk || softProtectedUsed > 0) result = status("Review", "review");
    else if (higherUsed > 0) result = status("Covered via upgrade", "upgrade");
    else if (offered === 0) result = status("Intentional sales choice", "intentional");
    else result = status("Within rules", "ok");
    results.push({ categoryCode: category.code, offeredRaw, offered, ownAvailable: rawOpera[allowed[0]], placements: categoryPlacements, higherPotential, higherUsed, softProtectedUsed, approvedOverbooking, uncovered: remaining, sharedTypes, exception: exception || null, ...result });
  });

  const rank = { action: 6, unreliable: 5, unassessable: 5, unconfigured: 5, review: 4, upgrade: 3, intentional: 2, ok: 1 };
  const worst = results.reduce((current, item) => rank[item.code] > rank[current.code] ? item : current, status("Within rules", "ok"));
  const totalOffered = categories.filter((item) => item.confirmed).reduce((sum, category) => sum + Math.max(0, marshaRooms[category.code] || 0), 0);
  const totalApprovedOverbooking = results.reduce((sum, item) => sum + (item.approvedOverbooking || 0), 0);
  const hotelLimitExceeded = settings.hotelSalesLimitConfirmed && totalOffered > Math.max(0, Number(settings.hotelSalesLimit) || 0) + totalApprovedOverbooking;
  const urgent = Math.max(0, Math.ceil((new Date(`${stayDate}T00:00:00Z`) - new Date(`${getBrusselsDateString()}T00:00:00Z`)) / 86400000)) <= 3;
  return { ...status(hotelLimitExceeded ? "Action required" : worst.label, hotelLimitExceeded ? "action" : worst.code), reason: hotelLimitExceeded ? `${totalOffered} rooms are offered across MARSHA categories, above the verified hotel-wide sales limit of ${settings.hotelSalesLimit} plus ${totalApprovedOverbooking} approved overbooking.` : worst.reason || "", categories: results, placements, deficitIssues, remainingPools: pools, totalOffered, hotelLimitExceeded, urgent, dataIssues: [] };
}

export function getSourceState({ stayDocument, snapshotDate, today, metadata = {} }) {
  if (snapshotDate > today) return { status: "expected", label: "Expected" };
  if (!stayDocument) return { status: snapshotDate === today ? "expected" : "missing", label: snapshotDate === today ? "Expected" : "Missing" };
  const completion = String(metadata.status || metadata.importStatus || "").toLowerCase();
  if (["failed", "error", "incomplete"].includes(completion)) return { status: "missing", label: "Missing" };
  if (snapshotDate < today) return { status: "stale", label: "Outdated" };
  return { status: "current", label: "Available and current" };
}
