const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateMonitor, evaluateMonitor, wallTime, runView, validDate } = require("./importMonitoringPolicy");

const monitor = { label: "Daily arrivals", fileType: "arrivals", timeZone: "Europe/Brussels", expectedBy: "07:30", graceMinutes: 30,
  weekdays: [0, 1, 2, 3, 4, 5, 6], businessDateOffsetDays: 0, startsOn: "2026-10-01", enabled: true, paused: false, acceptEmpty: false };
const at = (text) => Date.parse(text);
const observation = (fields = {}) => ({ runId: "source-a", fileType: "arrivals", businessDate: "2026-10-10", status: "succeeded",
  receivedAtMillis: at("2026-10-10T05:00:00Z"), updatedAtMillis: at("2026-10-10T05:05:00Z"),
  completedAtMillis: at("2026-10-10T05:05:00Z"), writtenCount: 150, ...fields });
const evaluate = (rows = [], policy = monitor, options = {}) => evaluateMonitor(policy, rows, { now: at("2026-10-10T07:00:00Z"), ...options });

test("monitoring distinguishes missing delivery from awaiting the local deadline", () => {
  assert.equal(evaluate().status, "overdue");
  assert.equal(evaluate([], monitor, { now: at("2026-10-10T05:59:00Z") }).status, "awaiting");
  assert.equal(evaluate([], monitor, { now: at("2026-10-10T06:00:00Z") }).status, "awaiting");
  assert.equal(evaluate([], monitor, { now: at("2026-10-10T06:00:01Z") }).status, "overdue");
  assert.equal(evaluate().deadlineMillis, at("2026-10-10T06:00:00Z"));
});
test("business dates, empty source and downstream failure cannot silently become healthy", () => {
  assert.equal(evaluate([observation()]).status, "healthy");
  assert.equal(evaluate([observation({ businessDate: "2026-10-09" })]).status, "overdue");
  assert.equal(evaluate([observation({ businessDate: null })]).status, "unknown");
  assert.equal(evaluate([observation({ receivedAtMillis: null })]).status, "unknown");
  assert.equal(evaluate([observation({ status: "empty", writtenCount: 0 })]).status, "empty");
  assert.equal(evaluate([observation({ status: "empty", writtenCount: 0 })], { ...monitor, acceptEmpty: true }).status, "healthy");
  assert.equal(evaluate([observation({ downstreamStatus: "failed" })]).status, "partial");
});
test("leases and explicit import failures are different recovery states", () => {
  assert.equal(evaluate([observation({ status: "failed" })]).status, "failed");
  assert.equal(evaluate([observation({ status: "processing", leaseUntilMillis: at("2026-10-10T08:00:00Z") })]).status, "processing");
  assert.equal(evaluate([observation({ status: "processing", leaseUntilMillis: at("2026-10-10T06:00:00Z") })]).status, "stalled");
});
test("missing legacy receipt timestamps do not hide proven failure or an expired processing lease", () => {
  assert.equal(evaluate([observation({ status: "failed", receivedAtMillis: null })]).status, "failed");
  assert.equal(evaluate([observation({ status: "processing", receivedAtMillis: null, leaseUntilMillis: 0 })]).status, "stalled");
});
test("a required downstream model remains pending, partial or unknown until completion is proven", () => {
  const run = observation({ downstreamStatus: "pending", completedAtMillis: at("2026-10-10T06:55:00Z") });
  assert.equal(evaluate([run]).status, "processing");
  assert.equal(evaluate([run], monitor, { now: at("2026-10-10T07:11:00Z") }).status, "partial");
  assert.equal(evaluate([{ ...run, downstreamStatus: "unknown" }]).status, "unknown");
  const legacy = runView("legacy", { state: "complete", result: { writtenCount: 5, affectsStayPattern: true } });
  assert.equal(legacy.downstreamStatus, "unknown");
});
test("disabled, paused, inactive and unconfigured sources are explicit", () => {
  assert.equal(evaluate([], null).status, "not-configured");
  assert.equal(evaluate([], { ...monitor, enabled: false }).status, "disabled");
  assert.equal(evaluate([], { ...monitor, paused: true }).status, "paused");
  assert.equal(evaluate([], monitor, { active: false }).status, "inactive");
  assert.equal(evaluate([], { ...monitor, startsOn: "2026-10-11" }).status, "awaiting");
  assert.equal(evaluate([], { ...monitor, timeZone: "made-up" }).status, "unknown");
});
test("bounded missing history stays unknown and weekday schedules keep Friday due on Saturday", () => {
  assert.equal(evaluate([], monitor, { historyTruncated: true }).status, "unknown");
  const weekdays = { ...monitor, weekdays: [1, 2, 3, 4, 5] };
  assert.equal(evaluate([], weekdays).occurrenceDate, "2026-10-09");
  assert.equal(evaluate([observation({ businessDate: "2026-10-09" })], weekdays).status, "healthy");
  const priorDate = { ...monitor, businessDateOffsetDays: -1 };
  assert.equal(evaluate([observation({ businessDate: "2026-10-09" })], priorDate).status, "healthy");
});
test("late replacement can resolve a historical occurrence without hiding today's missing source", () => {
  const late = observation({ businessDate: "2026-10-09", receivedAtMillis: at("2026-10-10T06:30:00Z") });
  assert.equal(evaluate([late]).status, "overdue");
  assert.equal(evaluate([late], monitor, { occurrenceDate: "2026-10-09" }).status, "healthy");
});
test("deadlines follow winter/summer offsets and explicit DST gap/fold rules", () => {
  assert.equal(wallTime("2026-01-10", "07:30", "Europe/Brussels"), at("2026-01-10T06:30:00Z"));
  assert.equal(wallTime("2026-07-10", "07:30", "Europe/Brussels"), at("2026-07-10T05:30:00Z"));
  assert.equal(wallTime("2026-03-29", "02:30", "Europe/Brussels"), at("2026-03-29T01:00:00Z"));
  assert.equal(wallTime("2026-10-25", "02:30", "Europe/Brussels"), at("2026-10-25T01:30:00Z"));
  assert.equal(validDate("2026-02-29"), false);
  assert.equal(validDate("2028-02-29"), true);
});
test("operator policies reject forged fields, invalid weekdays and unknown required values", () => {
  assert.deepEqual(validateMonitor(Object.fromEntries(Object.entries(monitor).filter(([key]) => key !== "fileType"))).weekdays, [0, 1, 2, 3, 4, 5, 6]);
  for (const change of [{ graceMinutes: null }, { acceptEmpty: "false" }, { weekdays: [1, 1] }, { expectedBy: "24:00" }, { startsOn: "2026-02-30" }, { schemaVersion: 999 }]) {
    assert.throws(() => validateMonitor({ ...Object.fromEntries(Object.entries(monitor).filter(([key]) => key !== "fileType")), ...change }), (error) => error.code === "invalid-argument");
  }
});
test("run views whitelist metadata, retain zero and do not manufacture a missing count/date", () => {
  const source = { descriptor: { fileType: "arrivals", password: "secret" }, configuration: { targetDateOverride: "2026-10-10", rawGuest: "private" },
    state: "complete", result: { writtenCount: 0, firstWrittenPath: "private/guest" }, updatedAt: at("2026-10-10T05:00:00Z") };
  const empty = runView("source", source);
  assert.equal(empty.status, "empty"); assert.equal(empty.writtenCount, 0); assert.equal(empty.receivedAtMillis, null);
  assert.equal(JSON.stringify(empty).includes("private"), false); assert.equal(JSON.stringify(empty).includes("secret"), false);
  assert.equal(runView("source", { ...source, result: {} }).status, "unknown");
  assert.equal(runView("source", { ...source, configuration: {} }).businessDate, null);
});
