import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

const projectId = "demo-hotel-suite-a00";
for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env[key] || "")) throw new Error("Only local emulators are allowed.");
}
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const monitoring = require("../../functions/src/platformMonitoring");
const telemetry = require("../../functions/src/purchasingTelemetry");
const { digest } = require("../../functions/src/validation");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { DEFAULT_PURCHASING_THRESHOLDS } = require("../../functions/src/purchasingMonitoringPolicy");
const db = admin.firestore(), auth = admin.auth();
const now = Date.parse("2026-10-17T10:00:00Z");
const operator = { uid: "operator", token: { email: "operator@example.test", email_verified: true, platformAdmin: true } };
const member = { uid: "member", token: { email: "member@example.test", email_verified: true } };
const outsider = { uid: "outsider", token: { email: "outsider@example.test", email_verified: true } };
const services = { firestore: db, auth, now: () => now };
const configuration = { schemaVersion: 1, projectId: "hotel-toolkit", environment: "production", enabled: true,
  releaseSha: "a".repeat(40), thresholds: { ...DEFAULT_PURCHASING_THRESHOLDS }, maxHotelsPerRun: 25,
  maxDocumentsPerSource: 40, evaluatorStaleMinutes: 45 };
const request = (actor, data = {}) => ({ auth: actor, data });
const rejected = (promise, code = "permission-denied") => assert.rejects(promise, { code });
const observation = (patch = {}) => ({ process: "dispatches", sourceId: "dispatch-one", status: "failed", code: "dispatch-failed",
  severity: "error", summary: "Dispatch preparation failed.", nextStep: "Inspect the protected order delivery history.", evidenceAtMillis: now, ...patch });
const incidentReference = (hotelUid = "hotel-a", process = "dispatches", sourceId = "dispatch-one", deployment = "production") =>
  db.doc(`platformIncidents/${digest("purchasing-v1", deployment, hotelUid, process, sourceId)}`);
const reconcile = (value = observation(), at = now, deployment = "production", hotelUid = "hotel-a") =>
  monitoring.reconcilePurchasingIncident(db, hotelUid, value, at, deployment);
let environment;

before(async () => {
  environment = await initializeTestEnvironment({ projectId, firestore: {
    host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)), rules: await readFile("firebase/firestore.rules", "utf8"),
  } });
});
beforeEach(async () => {
  await environment.clearFirestore();
  const users = await auth.listUsers();
  if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  for (const actor of [operator, member, outsider]) {
    await auth.createUser({ uid: actor.uid, email: actor.token.email, emailVerified: true });
    await auth.setCustomUserClaims(actor.uid, actor.token.platformAdmin ? { platformAdmin: true } : {});
    await db.doc(`users/${actor.uid}`).set({ hotelUid: actor === member ? ["hotel-a"] : [] });
  }
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const hotelUid of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotelUid}`).set({ hotelName: hotelUid });
    await db.doc(`hotelSubscriptions/${hotelUid}`).set({ status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 });
  }
  await db.doc("hotels/hotel-a/members/member").set({ permissions: ["orders.read", "orders.approve", "imports.read"], hotelAdmin: true });
});
after(async () => environment.cleanup());

describe("durable purchasing incident reconciliation", () => {
  it("deduplicates concurrent evaluations and isolates environment, tenant and source identity", async () => {
    await Promise.all(Array.from({ length: 4 }, () => reconcile()));
    const current = (await incidentReference().get()).data();
    assert.equal((await db.collection("platformIncidents").get()).size, 1);
    assert.equal(current.state, "open");
    assert.equal(current.episode, 1);
    assert.equal(current.firstDetectedAtMillis, now);
    await reconcile(observation(), now, "staging");
    await reconcile(observation(), now, "production", "hotel-b");
    await reconcile(observation({ sourceId: "dispatch-two" }));
    assert.equal((await db.collection("platformIncidents").get()).size, 4);
  });

  it("keeps acknowledgment separate from health and resets it only for a recovered incident's next episode", async () => {
    await reconcile();
    const reference = incidentReference();
    await monitoring.acknowledgePlatformIncidentHandler(request(operator, { incidentId: reference.id, reason: "Checking transport evidence" }), services);
    await reconcile(observation(), now + 1000);
    let current = (await reference.get()).data();
    assert.equal(current.state, "open");
    assert.equal(current.acknowledgedBy, operator.uid);
    assert.equal(current.episode, 1);
    await reconcile(observation({ status: "healthy", code: "dispatch-sent", severity: "info" }), now + 2000);
    current = (await reference.get()).data();
    assert.equal(current.state, "resolved");
    assert.equal(current.acknowledgedBy, operator.uid);
    assert.equal(current.resolvedAtMillis, now + 2000);
    assert.ok(current.expiresAt?.toMillis() > now);
    await reconcile(observation(), now + 3000);
    current = (await reference.get()).data();
    assert.equal(current.state, "open");
    assert.equal(current.episode, 2);
    assert.equal(current.acknowledgedBy, null);
    assert.equal(current.acknowledgedAtMillis, null);
    assert.equal(current.resolvedAtMillis, null);
    assert.equal(current.expiresAt ?? null, null, "An open recurring incident must no longer carry its resolved episode's retention deadline.");
    await monitoring.acknowledgePlatformIncidentHandler(request(operator, { incidentId: reference.id, reason: "Inspecting this new occurrence" }), { ...services, now: () => now + 3500 });
    assert.equal((await reference.get()).data().acknowledgedBy, operator.uid);
    assert.equal((await db.collection("platformAudit").get()).size, 2, "Every acknowledged episode must retain independent audit evidence.");
    await reconcile(observation({ status: "healthy", code: "dispatch-sent", severity: "info" }), now + 1000);
    assert.equal((await reference.get()).data().state, "open", "A delayed evaluation cannot resolve a newer fault.");
    await reconcile(observation({ status: "healthy", code: "dispatch-sent", severity: "info", evidenceAtMillis: now - 1000 }), now + 4000);
    assert.equal((await reference.get()).data().state, "open", "A newer evaluation cannot establish recovery from evidence older than the retained fault.");
    await reconcile(observation({ status: "healthy", code: "dispatch-sent", severity: "info", evidenceAtMillis: now + 5000 }), now + 5000);
    assert.equal((await reference.get()).data().state, "resolved");
    await reconcile(observation({ evidenceAtMillis: now + 6000 }), now + 4500);
    current = (await reference.get()).data();
    assert.equal(current.state, "open", "Newer fault evidence wins even when its evaluator started before a parallel refresh.");
    assert.equal(current.episode, 3);
    assert.equal(current.evidenceAtMillis, now + 6000);
    assert.equal(current.lastDetectedAtMillis, now + 5000);
    await reconcile(observation({ status: "unknown", code: "source-status-unknown", evidenceAtMillis: null }), now + 6500);
    await reconcile(observation({ status: "healthy", code: "dispatch-sent", severity: "info", evidenceAtMillis: now + 5000 }), now + 7000);
    assert.equal((await reference.get()).data().state, "open", "An undated unknown observation cannot erase the latest fault evidence and allow an older success to close it.");
    await reconcile(observation({ status: "healthy", code: "dispatch-sent", severity: "info", evidenceAtMillis: null }), now + 7000);
    assert.equal((await reference.get()).data().state, "open", "Recovery requires a usable source evidence timestamp.");
  });

  it("preserves an unresolved fault through missing, unknown, paused and simulated evidence", async () => {
    await reconcile();
    for (const status of ["unknown", "paused", "simulated"]) await reconcile(observation({ status, code: `dispatch-${status}` }), now + 1000);
    const previous = (await incidentReference().get()).data();
    assert.equal(previous.state, "open");
    assert.equal(previous.resolvedAtMillis, null);
    assert.equal(previous.episode, 1);
    await reconcile(observation({ sourceId: "unknown-first", status: "unknown", code: "dispatch-unknown" }), now + 2000);
    assert.notEqual((await incidentReference("hotel-a", "dispatches", "unknown-first").get()).data()?.state, "resolved");
  });

  it("evaluates retained source evidence without mutating or retrying the business workflow", async () => {
    const order = db.doc("hotels/hotel-a/orders/order-one"), dispatch = db.doc("hotels/hotel-a/dispatches/dispatch-one");
    await order.set({ status: "Created", revision: 7, privateNotes: "DO_NOT_EXPOSE" });
    await dispatch.set({ status: "failed", externalAttempt: false, createdAt: new Date(now - 60000),
      orderId: order.id, providerError: "DO_NOT_EXPOSE", recipient: "private@example.test", body: "DO_NOT_EXPOSE" });
    const beforeOrder = (await order.get()).data(), beforeDispatch = (await dispatch.get()).data();
    await monitoring.reconcileHotelPurchasingMonitoring(db, "hotel-a", configuration, now);
    const incident = incidentReference();
    assert.equal((await incident.get()).data().state, "open");
    assert.deepEqual((await order.get()).data(), beforeOrder);
    assert.deepEqual((await dispatch.get()).data(), beforeDispatch);
    assert.equal((await db.collection("hotels/hotel-a/dispatches").get()).size, 1);
    assert.equal((await db.collection("hotels/hotel-a/mailQueue").get()).size, 0);
    assert.equal((await db.collection("hotels/hotel-a/orderAudit").get()).size, 0);
    const metadata = { incident: (await incident.get()).data(), health: (await db.doc("hotels/hotel-a/platformHealth/purchasing").get()).data() };
    assert.equal(JSON.stringify(metadata).includes("DO_NOT_EXPOSE"), false);
    assert.equal(JSON.stringify(metadata).includes("private@example.test"), false);
    await dispatch.set({ ...beforeDispatch, status: "sent", via: "simulation", environment: "staging", providerId: "simulated-receipt" });
    await monitoring.reconcileHotelPurchasingMonitoring(db, "hotel-a", configuration, now + 500);
    assert.equal((await incident.get()).data().state, "open", "A staging simulation cannot establish real delivery or close a production fault.");
    await dispatch.delete();
    await monitoring.reconcileHotelPurchasingMonitoring(db, "hotel-a", configuration, now + 1000);
    assert.equal((await incident.get()).data().state, "open", "A source absent from a later bounded scan cannot prove recovery.");
    await dispatch.set({ ...beforeDispatch, status: "sent", via: "email", providerId: "receipt-one", sentAt: new Date(now + 2000) });
    await monitoring.reconcileHotelPurchasingMonitoring(db, "hotel-a", configuration, now + 2000);
    assert.equal((await incident.get()).data().state, "resolved");
    assert.equal((await order.get()).data().status, "Created");
    assert.equal((await db.collection("hotels/hotel-a/dispatches").get()).size, 1);
  });

  it("leases concurrent workers and retains the previous successful heartbeat when project configuration fails", { timeout: 30000 }, async () => {
    const expired = admin.firestore.Timestamp.fromMillis(now - 1000);
    await db.doc("hotels/hotel-a/workflowTelemetry/expired").set({ expiresAt: expired });
    await db.doc("hotels/hotel-a/workflowTelemetryLimits/expired").set({ expiresAt: expired, count: 1 });
    await db.doc("hotels/hotel-a/mailQueue/retained-source").set({ expiresAt: expired, status: "sent", providerId: "receipt-one" });
    await db.doc("platformIncidents/resolved-expired").set({ expiresAt: expired, state: "resolved" });
    await db.doc("platformIncidents/open-expired").set({ expiresAt: expired, state: "open" });
    let signalQueryReached, releaseQuery;
    const queryReached = new Promise((resolve) => { signalQueryReached = resolve; });
    const queryReleased = new Promise((resolve) => { releaseQuery = resolve; });
    // Hold the first real hotel query after its Firestore lease transaction has
    // committed, so the second worker definitely attempts an overlapping run.
    const holdHotelQuery = (query) => new Proxy(query, { get(target, key) {
      if (key === "get") return async () => { signalQueryReached(); await queryReleased; return target.get(); };
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args) => ["orderBy", "limit", "startAfter"].includes(key) ? holdHotelQuery(value.apply(target, args)) : value.apply(target, args);
    } });
    const heldDb = new Proxy(db, { get(target, key) {
      if (key === "collection") return (name) => name === "hotels" ? holdHotelQuery(target.collection(name)) : target.collection(name);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const firstRun = monitoring.runPlatformMonitoringWorker({ ...services, firestore: heldDb, configuration });
    let overlapping;
    try {
      await Promise.race([queryReached, firstRun.then(() => { throw new Error("The worker ended before reaching its hotel query."); })]);
      overlapping = await monitoring.runPlatformMonitoringWorker({ ...services, configuration });
    } finally { releaseQuery(); }
    const completed = await firstRun;
    assert.deepEqual(overlapping, { skipped: true, reason: "evaluation-already-running" });
    assert.equal(completed.checkedHotels, 2);
    assert.equal(completed.failedHotels, 0);
    assert.equal((await db.doc("hotels/hotel-a/workflowTelemetry/expired").get()).exists, false);
    assert.equal((await db.doc("hotels/hotel-a/workflowTelemetryLimits/expired").get()).exists, false);
    assert.equal((await db.doc("hotels/hotel-a/mailQueue/retained-source").get()).exists, true);
    assert.equal((await db.doc("platformIncidents/resolved-expired").get()).exists, false);
    assert.equal((await db.doc("platformIncidents/open-expired").get()).exists, true);
    const heartbeat = db.doc("platformConfiguration/importMonitoringWorker");
    assert.equal((await heartbeat.get()).data().lastSuccessfulAtMillis, now);
    await db.doc("platformConfiguration/purchasingMonitoring").set({ ...configuration, projectId: "hotel-toolkit-staging", environment: "staging" });
    await assert.rejects(monitoring.runPlatformMonitoringWorker({ ...services, now: () => now + 60000 }), /monitoring evaluation failed/i);
    const failed = (await heartbeat.get()).data();
    assert.equal(failed.lastSuccessfulAtMillis, now);
    assert.equal(failed.lastFailureAtMillis, now + 60000);
    assert.equal(failed.leaseUntilMillis, 0);
  });

  it("preserves a reopened incident and refreshed workflow evidence when retention races with their updates", async () => {
    const incidentPath = "platformIncidents/retention-race", telemetryPath = "hotels/hotel-a/workflowTelemetry/retention-race";
    const expiresAt = admin.firestore.Timestamp.fromMillis(now - 1000);
    await db.doc(incidentPath).set({ hotelUid: "hotel-a", state: "resolved", expiresAt });
    await db.doc(telemetryPath).set({ schemaVersion: 1, environment: "production", process: "orders", origin: "frontend",
      code: "internal", count: 1, firstOccurredAtMillis: now - 8 * 86400000, lastOccurredAtMillis: now - 8 * 86400000, expiresAt });
    const raced = new Set();
    const interceptBatch = (batch) => {
      const deletes = new Set();
      let proxy;
      proxy = new Proxy(batch, { get(target, key) {
        if (key === "delete") return (reference, ...args) => { deletes.add(reference.path); target.delete(reference, ...args); return proxy; };
        if (key === "commit") return async () => {
          // Change real emulator documents after the expiry snapshots were read
          // and before their protected batch deletes reach Firestore.
          for (const path of deletes) {
            if (raced.has(path)) continue;
            if (path === telemetryPath) {
              raced.add(path);
              await db.doc(path).update({ lastOccurredAtMillis: now + 1000, count: 2,
                expiresAt: admin.firestore.Timestamp.fromMillis(now + 7 * 86400000) });
            } else if (path === incidentPath) {
              raced.add(path);
              await db.doc(path).update({ state: "open", lastDetectedAtMillis: now + 1000, expiresAt: admin.firestore.FieldValue.delete() });
            }
          }
          return target.commit();
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      return proxy;
    };
    const racingDb = new Proxy(db, { get(target, key) {
      if (key === "batch") return () => interceptBatch(target.batch());
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    // A precondition failure may fail this evaluation; preservation is required
    // even when the worker reports that retryable monitoring failure.
    await monitoring.runPlatformMonitoringWorker({ ...services, firestore: racingDb, configuration }).catch(() => {});
    assert.deepEqual([...raced].sort(), [incidentPath, telemetryPath].sort());
    const retainedIncident = await db.doc(incidentPath).get(), retainedTelemetry = await db.doc(telemetryPath).get();
    assert.equal(retainedIncident.exists, true);
    assert.equal(retainedIncident.data().state, "open");
    assert.equal(retainedIncident.data().expiresAt, undefined);
    assert.equal(retainedTelemetry.exists, true);
    assert.equal(retainedTelemetry.data().count, 2);
    assert.equal(retainedTelemetry.data().lastOccurredAtMillis, now + 1000);
    assert.equal(retainedTelemetry.data().expiresAt.toMillis(), now + 7 * 86400000);
    assert.equal((await db.collection("hotels/hotel-a/orders").get()).size, 0);
    assert.equal((await db.collection("hotels/hotel-a/dispatches").get()).size, 0);
  });
});

describe("purchasing monitoring authority and data minimization", () => {
  it("serves incidents only through live verified platform authority without assigning hotel membership", async () => {
    await reconcile();
    const reference = incidentReference();
    await reference.update({ providerPayload: "DO_NOT_EXPOSE", supplierEmail: "private@example.test", secret: "DO_NOT_EXPOSE" });
    for (const actor of [member, outsider]) {
      await rejected(monitoring.listPlatformIncidentsHandler(request(actor), services));
      await rejected(monitoring.acknowledgePlatformIncidentHandler(request(actor, { incidentId: reference.id, reason: "Review" }), services));
    }
    const result = await monitoring.listPlatformIncidentsHandler(request(operator), services);
    assert.equal(result.incidents.length, 1);
    assert.equal(result.incidents[0].id, reference.id);
    assert.equal(JSON.stringify(result).includes("DO_NOT_EXPOSE"), false);
    assert.equal(JSON.stringify(result).includes("private@example.test"), false);
    assert.deepEqual((await db.doc("users/operator").get()).data().hotelUid, []);
    assert.equal((await db.doc("hotels/hotel-a/members/operator").get()).exists, false);
    await auth.setCustomUserClaims(operator.uid, {});
    await rejected(monitoring.listPlatformIncidentsHandler(request(operator), services));
    await rejected(monitoring.acknowledgePlatformIncidentHandler(request(operator, { incidentId: reference.id, reason: "Review" }), services));
  });

  it("denies direct metadata access and operational source access even to platform browser sessions", async () => {
    const paths = ["platformConfiguration/purchasingMonitoring", "platformWorkerHealth/contract-reminders", `platformIncidents/${incidentReference().id}`,
      "hotels/hotel-a/platformHealth/purchasing", "hotels/hotel-a/platformHealth/purchasingScan", "hotels/hotel-a/workflowTelemetry/event-one",
      "hotels/hotel-a/workflowTelemetryLimits/limit-one",
      "hotels/hotel-a/dispatches/dispatch-one", "hotels/hotel-a/mailQueue/mail-one", "hotels/hotel-a/supplierAiImportJobs/import-one",
      "hotels/hotel-a/catalogSyncJobs/sync-one", "hotels/hotel-b/dispatches/dispatch-two"];
    for (const path of paths) await db.doc(path).set({ status: "failed", privatePayload: "DO_NOT_EXPOSE" });
    for (const actor of [operator, member, outsider]) {
      const browser = environment.authenticatedContext(actor.uid, actor.token).firestore();
      for (const path of paths) {
        const reference = doc(browser, path);
        await assertFails(getDoc(reference));
        await assertFails(setDoc(reference, { status: "healthy" }));
        await assertFails(updateDoc(reference, { status: "healthy" }));
        await assertFails(deleteDoc(reference));
      }
    }
  });
});

describe("bounded unexpected workflow telemetry", () => {
  const runtimePolicy = { projectId: "hotel-toolkit-staging", environment: "staging", simulate: true, externalActions: false };
  const telemetryServices = { ...services, runtimePolicy };
  const payload = { hotelUid: "hotel-a", process: "orders", code: "internal" };
  const report = (actor = member, input = payload, overrides = {}) =>
    telemetry.reportHotelPurchasingErrorHandler(request(actor, input), { ...telemetryServices, ...overrides });
  const enableTelemetry = () => db.doc("platformConfiguration/purchasingMonitoring").set({ ...configuration,
    projectId: runtimePolicy.projectId, environment: runtimePolicy.environment });

  it("requires current hotel permission and the exact enabled environment before accepting a classification", async () => {
    assert.equal((await report()).accepted, false);
    await enableTelemetry();
    for (const actor of [operator, outsider]) await rejected(report(actor));
    await rejected(report(member, { ...payload, hotelUid: "hotel-b" }));
    await rejected(report(member, { ...payload, process: "contracts" }));
    await rejected(report(member, { ...payload, origin: "backend", error: "DO_NOT_EXPOSE" }), "invalid-argument");
    await rejected(report(member, { ...payload, code: "permission-denied" }), "invalid-argument");
    assert.equal((await report()).accepted, true);
    await db.doc("platformConfiguration/purchasingMonitoring").update({ environment: "production" });
    assert.equal((await report(member, payload, { now: () => now + 60000 })).accepted, false);
    await enableTelemetry();
    await db.doc("hotels/hotel-a/members/member").update({ permissions: [] });
    await rejected(report());
    await db.doc("hotels/hotel-a/members/member").update({ permissions: ["orders.read"] });
    await auth.updateUser(member.uid, { disabled: true });
    await rejected(report());
  });

  it("aggregates only bounded metadata, throttles duplicate reports and preserves the original backend outcome", async () => {
    await enableTelemetry();
    assert.equal((await report()).accepted, true);
    assert.equal((await report()).reason, "rate-limited");
    assert.equal((await report(member, payload, { now: () => now + 60000 })).accepted, true);
    const rows = await db.collection("hotels/hotel-a/workflowTelemetry").get();
    assert.equal(rows.size, 1);
    const data = rows.docs[0].data();
    assert.equal(data.count, 2);
    assert.equal(data.environment, "staging");
    assert.equal(data.origin, "frontend");
    assert.equal(data.expiresAt.toMillis(), now + 60000 + 7 * 86400000);
    assert.deepEqual(Object.keys(data).sort(), ["schemaVersion", "environment", "process", "origin", "code", "count",
      "firstOccurredAtMillis", "lastOccurredAtMillis", "correlationId", "expiresAt"].sort());
    let calls = 0;
    const original = Object.assign(new Error("DO_NOT_EXPOSE provider request body"), { code: "internal" });
    const wrapped = telemetry.withPurchasingTelemetry(async () => { calls++; throw original; }, "orders");
    await assert.rejects(wrapped(request(member, payload), telemetryServices), (error) => error === original);
    assert.equal(calls, 1);
    const stored = (await db.collection("hotels/hotel-a/workflowTelemetry").get()).docs.map((row) => row.data());
    assert.equal(stored.length, 2);
    assert.equal(stored.some((row) => row.origin === "backend"), true);
    assert.equal(JSON.stringify(stored).includes("DO_NOT_EXPOSE"), false);
    assert.equal(JSON.stringify(stored).includes(member.uid), false);
    assert.equal(JSON.stringify(stored).includes(member.token.email), false);
    assert.equal((await db.collection("hotels/hotel-a/orders").get()).size, 0);
    assert.equal((await db.collection("hotels/hotel-a/dispatches").get()).size, 0);
  });

  it("closes a reviewed workflow alert only with current platform authority and reopens it for a newer source occurrence", async () => {
    await enableTelemetry();
    const collectorConfiguration = { ...configuration, projectId: runtimePolicy.projectId, environment: runtimePolicy.environment };
    const order = db.doc("hotels/hotel-a/orders/reviewed-workflow-order");
    const originalOrder = { status: "Created", revision: 3, internalNotes: "DO_NOT_EXPOSE" };
    await order.set(originalOrder);
    await report();
    await monitoring.reconcileHotelPurchasingMonitoring(db, "hotel-a", collectorConfiguration, now);
    const incident = (await db.collection("platformIncidents").get()).docs.find((row) => row.data().process === "workflow");
    assert.ok(incident);
    const input = { incidentId: incident.id, expectedLastDetectedAtMillis: now, reason: "Reviewed the persisted workflow result and application fix" };
    const resolveIncident = (actor = operator, data = input, at = now) =>
      telemetry.resolvePlatformWorkflowIncidentHandler(request(actor, data), { ...telemetryServices, now: () => at });
    for (const actor of [member, outsider]) await rejected(resolveIncident(actor));
    await auth.setCustomUserClaims(operator.uid, {});
    await rejected(resolveIncident());
    await auth.setCustomUserClaims(operator.uid, { platformAdmin: true });
    await rejected(resolveIncident(operator, { ...input, markOrderSent: true }), "invalid-argument");
    await reconcile(observation(), now, runtimePolicy.environment);
    await rejected(resolveIncident(operator, { ...input, incidentId: incidentReference("hotel-a", "dispatches", "dispatch-one", runtimePolicy.environment).id }), "failed-precondition");
    await report(member, payload, { now: () => now + 60000 });
    await rejected(resolveIncident(operator, input, now + 60000), "aborted");
    assert.equal((await incident.ref.get()).data().state, "open");
    await monitoring.reconcileHotelPurchasingMonitoring(db, "hotel-a", collectorConfiguration, now + 60000);
    await resolveIncident(operator, { ...input, expectedLastDetectedAtMillis: now + 60000 }, now + 61000);
    const reviewed = (await incident.ref.get()).data();
    assert.equal(reviewed.state, "resolved");
    await monitoring.reconcilePurchasingIncident(db, "hotel-a", { process: reviewed.process, sourceId: reviewed.sourceId,
      status: "needs-review", code: reviewed.code, severity: reviewed.severity, summary: reviewed.summary,
      nextStep: reviewed.nextStep, evidenceAtMillis: reviewed.evidenceAtMillis }, now + 61500, runtimePolicy.environment);
    assert.equal((await incident.ref.get()).data().state, "resolved", "A concurrent evaluator holding the reviewed workflow occurrence cannot reopen its closed alert.");
    await monitoring.reconcileHotelPurchasingMonitoring(db, "hotel-a", collectorConfiguration, now + 62000);
    assert.equal((await incident.ref.get()).data().state, "resolved");
    assert.deepEqual((await order.get()).data(), originalOrder);
    assert.equal((await db.collection("hotels/hotel-a/dispatches").get()).size, 0);
    assert.equal((await db.collection("hotels/hotel-a/mailQueue").get()).size, 0);
    await report(member, payload, { now: () => now + 120000 });
    await monitoring.reconcileHotelPurchasingMonitoring(db, "hotel-a", collectorConfiguration, now + 120000);
    const recurring = (await incident.ref.get()).data();
    assert.equal(recurring.state, "open");
    assert.equal(recurring.episode, 2);
    assert.equal(recurring.resolvedAtMillis, null);
    assert.deepEqual((await order.get()).data(), originalOrder);
  });
});
