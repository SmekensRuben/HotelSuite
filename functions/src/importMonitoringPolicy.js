const { HttpsError } = require("firebase-functions/v2/https");

const DAY = 86400000;
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
function zonedParts(time, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(time));
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}
function localDate(time, timeZone) {
  const parts = zonedParts(time, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function wallTime(date, hhmm, timeZone) {
  const wall = Date.parse(`${date}T${hhmm}:00Z`);
  // Collect both offsets around a DST boundary; choose the later occurrence of
  // an ambiguous clock time. A skipped clock minute shifts to the first valid one.
  const offsets = [...new Set([-DAY, 0, DAY].map((delta) => {
    const time = wall + delta;
    const p = zonedParts(time, timeZone);
    return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - time;
  }))];
  for (let minute = 0; minute <= 180; minute++) {
    const desired = wall + minute * 60000;
    const expected = new Date(desired).toISOString().slice(0, 16);
    const candidates = offsets.map((offset) => desired - offset).filter((candidate) => {
      const p = zonedParts(candidate, timeZone);
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === expected;
    });
    if (candidates.length) return Math.max(...candidates);
  }
  throw new Error("The configured local deadline cannot be resolved.");
}

function validateMonitor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpsError("invalid-argument", "A monitoring policy is required.");
  const allowed = ["label", "timeZone", "expectedBy", "graceMinutes", "weekdays", "businessDateOffsetDays", "startsOn", "paused", "enabled", "acceptEmpty"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new HttpsError("invalid-argument", "Unsupported monitoring field.");
  if (typeof input.label !== "string" || !input.label.trim() || input.label.length > 120 || /[\u0000-\u001f]/.test(input.label)) throw new HttpsError("invalid-argument", "Use a label of 1–120 characters.");
  try {
    if (typeof input.timeZone !== "string" || input.timeZone.length > 80) throw new Error();
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone }).format(new Date());
  } catch { throw new HttpsError("invalid-argument", "Choose a valid IANA time zone."); }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.expectedBy || "") || !validDate(input.startsOn)) throw new HttpsError("invalid-argument", "Choose a valid local deadline and start date.");
  if (!Number.isInteger(input.graceMinutes) || input.graceMinutes < 0 || input.graceMinutes > 720
    || !Number.isInteger(input.businessDateOffsetDays) || Math.abs(input.businessDateOffsetDays) > 366) throw new HttpsError("invalid-argument", "Review the grace period and business-date offset.");
  if (!Array.isArray(input.weekdays) || !input.weekdays.length || input.weekdays.length > 7
    || input.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) || new Set(input.weekdays).size !== input.weekdays.length) throw new HttpsError("invalid-argument", "Choose unique weekdays.");
  for (const flag of ["enabled", "paused", "acceptEmpty"]) if (typeof input[flag] !== "boolean") throw new HttpsError("invalid-argument", `${flag} must be a boolean.`);
  return { schemaVersion: 1, label: input.label.trim(), timeZone: input.timeZone, expectedBy: input.expectedBy,
    graceMinutes: input.graceMinutes, weekdays: [...input.weekdays].sort(), businessDateOffsetDays: input.businessDateOffsetDays,
    startsOn: input.startsOn, enabled: input.enabled, paused: input.paused, acceptEmpty: input.acceptEmpty };
}

function runView(id, run, previous = {}) {
  const descriptor = run.descriptor || {};
  const knownTime = (value) => Number.isFinite(value) && value > 0 ? value : null;
  const writtenCount = run.result?.writtenCount;
  const businessDate = validDate(run.configuration?.targetDateOverride) ? run.configuration.targetDateOverride
    : validDate(previous.businessDate) ? previous.businessDate : null;
  const status = run.state === "complete" ? (Number.isSafeInteger(writtenCount) && writtenCount >= 0 ? writtenCount === 0 ? "empty" : "succeeded" : "unknown")
    : run.state === "failed" || run.errorCode ? "failed" : run.state === "processing" ? "processing" : "unknown";
  return { schemaVersion: 1, runId: id, fileType: typeof descriptor.fileType === "string" ? descriptor.fileType.slice(0, 128) : previous.fileType ?? null,
    status, businessDate, receivedAtMillis: knownTime(run.receivedAtMillis) ?? previous.receivedAtMillis ?? null,
    firstObservedAtMillis: knownTime(run.createdAt) ?? previous.firstObservedAtMillis ?? null,
    updatedAtMillis: knownTime(run.updatedAt), leaseUntilMillis: knownTime(run.leaseUntil),
    completedAtMillis: run.state === "complete" ? knownTime(run.updatedAt) : null,
    writtenCount: Number.isSafeInteger(writtenCount) && writtenCount >= 0 ? writtenCount : null,
    errorCode: run.errorCode ? "import-processing-failed" : null,
    downstreamStatus: ["failed", "complete", "pending"].includes(run.downstreamStatus) ? run.downstreamStatus : run.result?.affectsStayPattern ? "unknown" : null,
    retryable: run.state !== "complete", legacyTelemetry: !knownTime(run.receivedAtMillis) };
}

function evaluateMonitor(monitor, observations, { now = Date.now(), active = true, historyTruncated = false, occurrenceDate } = {}) {
  const result = { status: "not-configured", expectedBusinessDate: null, occurrenceDate: null, deadlineMillis: null, run: null, historyTruncated };
  if (!monitor) return result;
  let policy;
  try {
    const keys = ["label", "timeZone", "expectedBy", "graceMinutes", "weekdays", "businessDateOffsetDays", "startsOn", "paused", "enabled", "acceptEmpty"];
    policy = validateMonitor(Object.fromEntries(keys.map((key) => [key, monitor[key]])));
  } catch { return { ...result, status: "unknown" }; }
  if (!active) return { ...result, status: "inactive" };
  if (!policy.enabled) return { ...result, status: "disabled" };
  if (policy.paused) return { ...result, status: "paused" };
  let date = occurrenceDate || localDate(now, policy.timeZone);
  if (!validDate(date)) return { ...result, status: "unknown" };
  for (let n = 0; n < 7 && !policy.weekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay()); n++) date = shiftDate(date, -1);
  if (date < policy.startsOn) return { ...result, status: "awaiting" };
  const deadline = wallTime(date, policy.expectedBy, policy.timeZone) + policy.graceMinutes * 60000;
  const expectedBusinessDate = shiftDate(date, policy.businessDateOffsetDays);
  const beginning = wallTime(date, "00:00", policy.timeZone);
  const candidates = observations.filter((run) => run.fileType === monitor.fileType && run.businessDate === expectedBusinessDate)
    .sort((a, b) => (b.updatedAtMillis || 0) - (a.updatedAtMillis || 0) || a.runId.localeCompare(b.runId));
  const run = candidates[0] || null;
  Object.assign(result, { occurrenceDate: date, expectedBusinessDate, deadlineMillis: deadline, run });
  if (run) {
    if (run.status === "failed") return { ...result, status: "failed" };
    if (run.status === "processing") return { ...result, status: run.leaseUntilMillis && run.leaseUntilMillis > now ? "processing" : "stalled" };
    if (!run.receivedAtMillis || !run.completedAtMillis && ["succeeded", "empty"].includes(run.status)) return { ...result, status: "unknown" };
    if (["succeeded", "empty"].includes(run.status) && run.downstreamStatus === "unknown") return { ...result, status: "unknown" };
    if (["succeeded", "empty"].includes(run.status) && run.downstreamStatus === "pending") return { ...result, status: now - run.completedAtMillis > 15 * 60000 ? "partial" : "processing" };
    // A known data date is necessary, but receiving the file does not validate its domain content.
    if (run.status === "succeeded") return { ...result, status: run.downstreamStatus === "failed" ? "partial" : "healthy" };
    if (run.status === "empty") return { ...result, status: policy.acceptEmpty ? "healthy" : "empty" };
    if (["failed", "received"].includes(run.status)) return { ...result, status: run.status === "received" ? now > deadline ? "stalled" : "processing" : "failed" };
    return { ...result, status: "unknown" };
  }
  if (observations.some((item) => item.fileType === monitor.fileType && !item.businessDate && (item.receivedAtMillis || item.updatedAtMillis || 0) >= beginning)) return { ...result, status: "unknown" };
  if (historyTruncated) return { ...result, status: "unknown" };
  return { ...result, status: now > deadline ? "overdue" : "awaiting" };
}

module.exports = { validDate, shiftDate, localDate, wallTime, validateMonitor, runView, evaluateMonitor };
