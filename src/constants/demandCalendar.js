export const SYSTEM_TYPES = {
  SCHOOL_HOLIDAY: "School Holiday", PUBLIC_HOLIDAY: "Public Holiday", BRIDGE_DAY: "Bridge Day",
  BUSINESS_EVENT: "Business Event", LEISURE_EVENT: "Leisure Event",
  CITYWIDE_COMPRESSION: "Citywide Compression", FESTIVE_PERIOD: "Festive Period", OTHER: "Other",
};

export const IMPACT_LEVELS = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };
export const DEMAND_EFFECTS = { SUPPRESS: "Suppresses Demand", NEUTRAL: "Neutral", BOOST: "Increases Demand" };

export const optionEntries = (values) => Object.entries(values).map(([value, label]) => ({ value, label }));

export const EMPTY_EVENT = {
  name: "", categoryId: "", systemType: "", startDate: "", endDate: "", impactLevel: "MEDIUM",
  groupDemandEffect: "NEUTRAL", transientBusinessEffect: "NEUTRAL", transientLeisureEffect: "NEUTRAL",
  bqtDemandEffect: "NEUTRAL", region: "", active: true, expectedAttendance: "", venue: "", notes: "",
  source: "", sourceUrl: "", confidence: "",
};

export const EMPTY_CATEGORY = {
  name: "", systemType: "", defaultImpactLevel: "MEDIUM", defaultGroupDemandEffect: "NEUTRAL",
  defaultTransientBusinessEffect: "NEUTRAL", defaultTransientLeisureEffect: "NEUTRAL",
  defaultBqtDemandEffect: "NEUTRAL", description: "", active: true,
};

export function validateDemandCalendarEvent(event) {
  const errors = {};
  ["name", "categoryId", "systemType", "startDate", "endDate", "impactLevel", "groupDemandEffect",
    "transientBusinessEffect", "transientLeisureEffect", "bqtDemandEffect", "region"].forEach((field) => {
    if (!String(event[field] ?? "").trim()) errors[field] = "Required";
  });
  if (event.startDate && event.endDate && event.endDate < event.startDate) errors.endDate = "End Date must be on or after Start Date";
  if (event.expectedAttendance !== "" && Number(event.expectedAttendance) < 0) errors.expectedAttendance = "Expected Attendance cannot be negative";
  if (event.sourceUrl) { try { new URL(event.sourceUrl); } catch { errors.sourceUrl = "Enter a valid URL"; } }
  return errors;
}

export const categoryDefaultsForEvent = (category) => ({
  systemType: category.systemType,
  impactLevel: category.defaultImpactLevel || "MEDIUM",
  groupDemandEffect: category.defaultGroupDemandEffect || "NEUTRAL",
  transientBusinessEffect: category.defaultTransientBusinessEffect || "NEUTRAL",
  transientLeisureEffect: category.defaultTransientLeisureEffect || "NEUTRAL",
  bqtDemandEffect: category.defaultBqtDemandEffect || "NEUTRAL",
});
