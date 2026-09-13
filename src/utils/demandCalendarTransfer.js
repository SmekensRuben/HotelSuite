import { DEMAND_EFFECTS, IMPACT_LEVELS, SYSTEM_TYPES, validateDemandCalendarEvent } from "../constants/demandCalendar";

const FORMAT = "hotel-suite-demand-calendar";
const VERSION = 1;
const EVENT_FIELDS = ["name", "categoryId", "systemType", "startDate", "endDate", "impactLevel", "groupDemandEffect", "transientBusinessEffect", "transientLeisureEffect", "bqtDemandEffect", "region", "active", "expectedAttendance", "venue", "notes", "source", "sourceUrl", "confidence"];
const CATEGORY_FIELDS = ["name", "systemType", "defaultImpactLevel", "defaultGroupDemandEffect", "defaultTransientBusinessEffect", "defaultTransientLeisureEffect", "defaultBqtDemandEffect", "active", "description"];
const pick = (item, fields) => ({ id: item.id, ...Object.fromEntries(fields.map((field) => [field, item[field] ?? null])) });

export function createDemandCalendarExport(events, categories) {
  return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), categories: categories.map((item) => pick(item, CATEGORY_FIELDS)), events: events.map((item) => pick(item, EVENT_FIELDS)) };
}

export function parseDemandCalendarImport(contents) {
  let parsed;
  try { parsed = JSON.parse(contents); } catch { throw new Error("The selected file does not contain valid JSON."); }
  if (parsed?.format !== FORMAT || parsed?.version !== VERSION || !Array.isArray(parsed.categories) || !Array.isArray(parsed.events)) throw new Error("The selected file is not a valid Demand Calendar export.");
  const categories = parsed.categories.map((item) => ({
    ...pick(item, CATEGORY_FIELDS),
    defaultImpactLevel: item.defaultImpactLevel || "MEDIUM",
    defaultGroupDemandEffect: item.defaultGroupDemandEffect || "NEUTRAL",
    defaultTransientBusinessEffect: item.defaultTransientBusinessEffect || "NEUTRAL",
    defaultTransientLeisureEffect: item.defaultTransientLeisureEffect || "NEUTRAL",
    defaultBqtDemandEffect: item.defaultBqtDemandEffect || "NEUTRAL",
    active: item.active !== false,
  }));
  const events = parsed.events.map((item) => pick(item, EVENT_FIELDS));
  const categoryIds = new Set(categories.map((item) => item.id));
  const validEffect = (value) => value in DEMAND_EFFECTS;
  if (categories.some((item) => !item.id || !String(item.name || "").trim() || !(item.systemType in SYSTEM_TYPES) || !(item.defaultImpactLevel in IMPACT_LEVELS) || !validEffect(item.defaultGroupDemandEffect) || !validEffect(item.defaultTransientBusinessEffect) || !validEffect(item.defaultTransientLeisureEffect) || !validEffect(item.defaultBqtDemandEffect))) throw new Error("The export contains an invalid category.");
  if (events.some((item) => !item.id || typeof item.active !== "boolean" || !categoryIds.has(item.categoryId) || Object.keys(validateDemandCalendarEvent(item)).length || !(item.systemType in SYSTEM_TYPES) || !(item.impactLevel in IMPACT_LEVELS) || !validEffect(item.groupDemandEffect) || !validEffect(item.transientBusinessEffect) || !validEffect(item.transientLeisureEffect) || !validEffect(item.bqtDemandEffect) || (item.confidence && !(item.confidence in IMPACT_LEVELS)))) throw new Error("The export contains an invalid calendar event.");
  return { categories, events };
}

export const getDemandCalendarExportFilename = () => `demand-calendar-${new Date().toISOString().slice(0, 10)}.json`;
