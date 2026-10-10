const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveAuthorizedRecipients, configuredRecipientUids, deliverScheduledMail, requireAcknowledgment, stableDigest } = require("./scheduledMailDelivery");
const { processContractCancellationReminders, runContractCancellationRemindersNowHandler } = require("./contracts");
const { processGuestIntelligenceForHotel, cleanupGuestIntelligenceForHotel, RETENTION_MS, researchGuests, processNightlyGuestIntelligenceHandler } = require("./guestIntelligence");
const { getLatestGuestIntelligence, sendGuestIntelligenceMail } = require("./guestIntelligenceMail");
const { processMailQueueHandler } = require("./mailQueue");
const { sendOccupancyMail } = require("./occupancyMail");
const { sendScheduledBlockPickupReportHandler } = require("./blockPickupMail");

function memoryDb(initial = {}) {
  const rows = new Map(Object.entries(initial));
  let tail = Promise.resolve();
  const snapshot = (path) => ({ id: path.split("/").at(-1), ref: doc(path), exists: rows.has(path), data: () => structuredClone(rows.get(path)) });
  const collection = (path, maximum = Infinity) => ({ path, id: path.split("/").at(-1),
    doc: (id) => doc(`${path}/${id}`), limit: (n) => collection(path, n),
    get: async () => {
      const docs = [...rows.keys()].filter((key) => key.startsWith(`${path}/`) && key.split("/").length === path.split("/").length + 1).sort().slice(0, maximum).map(snapshot);
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
    listDocuments: async () => [...new Set([...rows.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => key.split("/").slice(0, path.split("/").length + 1).join("/")))].map(doc),
  });
  const apply = (operations) => operations.forEach(([kind, path, data, options]) => {
    if (kind === "delete") rows.delete(path);
    else if (kind === "update" || options?.merge) rows.set(path, { ...(rows.get(path) || {}), ...structuredClone(data) });
    else { if (kind === "create" && rows.has(path)) throw new Error("already exists"); rows.set(path, structuredClone(data)); }
  });
  const doc = (path) => ({ path, id: path.split("/").at(-1), get: async () => snapshot(path), collection: (name) => collection(`${path}/${name}`),
    listCollections: async () => [...new Set([...rows.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => key.split("/")[path.split("/").length]))].map((name) => collection(`${path}/${name}`)),
    set: async (data, options) => apply([["set", path, data, options]]), update: async (data) => apply([["update", path, data]]), delete: async () => rows.delete(path),
  });
  const db = { rows, doc, collection,
    collectionGroup: (name) => ({ get: async () => ({ docs: [...rows.keys()].filter((p) => p.split("/").at(-2) === name).map(snapshot) }) }),
    batch: () => { const operations = []; return { set: (r, d, o) => operations.push(["set", r.path, d, o]), delete: (r) => operations.push(["delete", r.path]), commit: async () => apply(operations) }; },
    runTransaction: (callback) => {
      const result = tail.then(async () => {
        const operations = [];
        const tx = { get: (ref) => ref.get(), getAll: (...refs) => Promise.all(refs.map((r) => r.get())),
          set: (r, d, o) => operations.push(["set", r.path, d, o]), update: (r, d) => operations.push(["update", r.path, d]), create: (r, d) => operations.push(["create", r.path, d]), delete: (r) => operations.push(["delete", r.path]) };
        const output = await callback(tx); apply(operations); return output;
      });
      tail = result.catch(() => {}); return result;
    },
  };
  return db;
}

const NOW = Date.parse("2026-10-10T08:00:00Z");
const DATE = "2026-10-10";
const sourcePath = `hotels/a/reports/arrivalsmadeyesterday/${DATE}`;
const guest = (name = "Ada Lovelace") => ({ fullName: name, arrivalDate: "2026-10-10", departureDate: "2026-10-15" });
const user = (uid, changes = {}) => ({ uid, email: `${uid}@example.test`, emailVerified: true, disabled: false, ...changes });
const auth = (users) => ({ getUser: async (uid) => { if (!users[uid]) { const e = new Error("removed"); e.code = "auth/user-not-found"; throw e; } return users[uid]; } });
function baseDb(extra = {}) {
  return memoryDb({ "hotelSubscriptions/a": { status: "active" }, "hotels/a": { hotelName: "Hotel A" }, "apiKeys/hotelToolkitAIKey": { value: "fictional-secret", model: "gpt-4.1-mini" }, [`${sourcePath}/r1`]: guest(), ...extra });
}
function fetchResearch(counter, action) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const subjects = JSON.parse(body.input[1].content.split("\n").at(-1));
    counter.push({ body, subjects });
    if (action) await action(counter.length, subjects);
    return { ok: true, json: async () => ({ output_text: JSON.stringify({ guests: subjects.map(({ reservationId }) => ({ reservationId,
      employer: null, jobTitle: null, professionalProfile: null, notableFacts: [], isVip: null, vipReason: null, identityNotes: "Unknown", identityConfidence: "low", vipConfidence: null, profileImageUrl: null, profileImageSourceUrl: null, sources: [],
    })) }) }) };
  };
}
const options = (db, fetchImpl) => ({ db, fetchImpl, now: () => NOW });

test("scheduled recipients use current hotel permissions and Auth, never a historical email", async () => {
  const db = baseDb({ "hotels/a/members/ok": { permissions: ["contracts.read"] }, "hotels/a/members/disabled": { permissions: ["contracts.read"] }, "hotels/a/members/unverified": { permissions: ["contracts.read"] }, "hotels/a/members/no-permission": { permissions: [] } });
  const currentAuth = auth({ ok: user("ok", { email: "changed@example.test" }), disabled: user("disabled", { disabled: true }), unverified: user("unverified", { emailVerified: false }), "no-permission": user("no-permission"), removed: user("removed") });
  assert.deepEqual(await resolveAuthorizedRecipients({ db, auth: currentAuth, hotelUid: "a", recipientUids: ["ok", "disabled", "unverified", "removed", "no-permission"], feature: "contracts" }), ["changed@example.test"]);
  assert.throws(() => configuredRecipientUids({ sendList: ["old@example.test"] }, "a"), /recipientUidsByHotel/);
  db.rows.set("hotelSubscriptions/a", { status: "suspended" });
  assert.deepEqual(await resolveAuthorizedRecipients({ db, auth: currentAuth, hotelUid: "a", recipientUids: ["ok"], feature: "contracts" }), []);
});

test("contract reminder rebinds snapshotted followers and a repeated run sends once", async () => {
  const db = baseDb({ "hotels/a/members/ok": { permissions: ["contracts.read"] }, "hotels/a/contracts/c": { name: "Lease", cancelBefore: DATE, endDate: DATE, reminderDays: [0], followers: [{ id: "ok", email: "stale@example.test" }, { id: "removed", email: "removed@example.test" }, { email: "raw@example.test" }] } });
  const sent = [];
  const services = { db, auth: auth({ ok: user("ok", { email: "current@example.test" }) }), now: new Date(NOW), send: async (p) => { sent.push(p); return { data: { id: "mail-1" } }; }, from: "app@example.test", appBaseUrl: "https://example.test" };
  await processContractCancellationReminders(services);
  await processContractCancellationReminders(services);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["current@example.test"]);
});

test("mail acknowledgment requires an ID and rejects resolved provider errors", () => {
  assert.equal(requireAcknowledgment({ data: { id: "m1" } }), "m1");
  for (const response of [{ error: { message: "failed" } }, { data: {} }, { data: { id: " " } }]) assert.throws(() => requireAcknowledgment(response), /acknowledge/);
});

test("durable scheduled mail claims block ambiguous retries and concurrent duplicates", async () => {
  const db = baseDb(); let calls = 0;
  const input = { db, hotelUid: "a", deliveryKey: "test/day", payload: { to: ["a@example.test"], text: "test" }, send: async () => { calls += 1; throw new Error("timeout after send"); } };
  await assert.rejects(deliverScheduledMail(input), (error) => error.code === "mail-needs-review" && !error.message.includes("timeout") && !error.cause);
  await assert.rejects(deliverScheduledMail(input), /Reconcile/);
  assert.equal(calls, 1);
  assert.equal([...db.rows.values()].find((r) => r.deliveryKey)?.status, "needs-review");
  const second = { ...input, deliveryKey: "test/other-day", send: async () => { calls += 1; return { data: { id: "m2" } }; } };
  const results = await Promise.allSettled([deliverScheduledMail(second), deliverScheduledMail(second)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(calls, 2);
  assert.equal((await deliverScheduledMail(second)).duplicate, true);
  assert.equal(calls, 2);
});

test("guest research minimizes the outbound payload, checkpoints unchanged source and replaces changed/removed/empty results", async () => {
  const db = baseDb(); const requests = []; const fetchImpl = fetchResearch(requests);
  const first = await processGuestIntelligenceForHotel("a", options(db, fetchImpl));
  assert.equal(first.written, 1);
  assert.deepEqual(Object.keys(requests[0].subjects[0]).sort(), ["fullName", "reservationId"]);
  assert.notEqual(requests[0].subjects[0].reservationId, "r1");
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.input[1].content.includes("2026-10-15"), false);
  assert.equal((await processGuestIntelligenceForHotel("a", options(db, fetchImpl))).status, "unchanged");
  assert.equal(requests.length, 1);
  db.rows.delete(`${sourcePath}/r1`); db.rows.set(`${sourcePath}/r2`, guest("Grace Hopper"));
  const replaced = await processGuestIntelligenceForHotel("a", options(db, fetchImpl));
  assert.notEqual(replaced.versionId, first.versionId);
  assert.deepEqual((await getLatestGuestIntelligence("a", db, NOW)).guests.map((g) => g.reservationId), ["r2"]);
  db.rows.delete(`${sourcePath}/r2`);
  // A source-date collection exists in Firestore even when a logical empty import leaves a noncandidate row.
  db.rows.set(`${sourcePath}/empty`, {});
  const empty = await processGuestIntelligenceForHotel("a", options(db, fetchImpl));
  assert.equal(empty.status, "completed"); assert.equal(empty.written, 0);
  assert.deepEqual((await getLatestGuestIntelligence("a", db, NOW)).guests, []);
  assert.equal(requests.length, 2);
});

test("guest runs resume completed checkpoints after interruption without repeated research", async () => {
  const db = baseDb({ [`${sourcePath}/r2`]: guest("Grace Hopper") }); const requests = [];
  await assert.rejects(processGuestIntelligenceForHotel("a", options(db, fetchResearch(requests, async (call) => { if (call === 2) throw new Error("interrupted"); }))), /provider response was unavailable or invalid/);
  assert.equal((await getLatestGuestIntelligence("a", db, NOW)).status, "unavailable");
  const completed = await processGuestIntelligenceForHotel("a", options(db, fetchResearch(requests)));
  assert.equal(completed.written, 2);
  assert.equal(requests.length, 3);
  assert.equal((await getLatestGuestIntelligence("a", db, NOW)).guests.length, 2);
});

test("concurrent guest workers cannot publish twice and a changed source invalidates in-flight results", async () => {
  const db = baseDb(); const requests = []; let release; let started;
  const startedPromise = new Promise((r) => { started = r; }); const wait = new Promise((r) => { release = r; });
  const first = processGuestIntelligenceForHotel("a", options(db, fetchResearch(requests, async () => { started(); await wait; })));
  await startedPromise;
  assert.equal((await processGuestIntelligenceForHotel("a", options(db, fetchResearch(requests)))).status, "busy");
  db.rows.set(`${sourcePath}/r1`, guest("Changed Guest")); release();
  assert.equal((await first).status, "source-changed");
  assert.equal((await getLatestGuestIntelligence("a", db, NOW)).status, "unavailable");
  assert.equal(requests.length, 1);
});

test("guest mail selects a current completed source-matched version and isolates each hotel's recipients", async () => {
  const db = baseDb({ "hotels/a/members/reader": { permissions: ["reservations.read"] }, "scheduledMails/guestIntelligence": { hotelUid: ["a"], recipientUidsByHotel: { a: ["reader"] }, sendList: ["legacy-global@example.test"] } });
  const requests = []; await processGuestIntelligenceForHotel("a", options(db, fetchResearch(requests)));
  const sent = []; const input = { firestore: db, auth: auth({ reader: user("reader") }), now: () => NOW, from: "app@example.test", send: async (p) => { sent.push(p); return { data: { id: "g1" } }; } };
  await sendGuestIntelligenceMail(input); await sendGuestIntelligenceMail(input);
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ["reader@example.test"]);
  db.rows.set(`${sourcePath}/r1`, guest("Modified Guest"));
  assert.equal((await sendGuestIntelligenceMail(input))[0].status, "source-unavailable");
  assert.equal(sent.length, 1);
});

test("guest data expires within 24 hours and periodic cleanup deletes both versions and legacy records", async () => {
  const db = baseDb({ "hotels/a/guestIntelligence/2020-01-01/guests/legacy": { fullName: "Old Guest" } });
  const run = await processGuestIntelligenceForHotel("a", options(db, fetchResearch([])));
  assert.ok(RETENTION_MS <= 86400000);
  const expires = db.rows.get(`hotels/a/guestIntelligenceVersions/${run.versionId}`).expiresAt.getTime();
  assert.ok(expires <= NOW + 86400000);
  assert.equal(db.rows.has("hotels/a/guestIntelligence/2020-01-01/guests/legacy"), false);
  assert.equal((await getLatestGuestIntelligence("a", db, expires)).status, "unavailable");
  await cleanupGuestIntelligenceForHotel("a", { db, now: () => expires });
  assert.equal([...db.rows.keys()].some((key) => key.includes("guestIntelligenceVersions/")), false);
});


test("resolved provider errors and missing IDs never mark a scheduled receipt sent", async () => {
  const db = baseDb(); let calls = 0;
  for (const [index, response] of [{ error: { message: "Rejected" } }, { data: {} }].entries()) {
    const input = { db, hotelUid: "a", deliveryKey: `rejected/${index}`, payload: { text: "fixture" }, send: async () => { calls += 1; return response; } };
    await assert.rejects(deliverScheduledMail(input), /acknowledge/);
    await assert.rejects(deliverScheduledMail(input), /Reconcile/);
  }
  assert.equal(calls, 2);
  assert.equal([...db.rows.values()].filter((r) => r.deliveryKey?.startsWith("rejected/")).every((r) => r.status === "needs-review"), true);
});

test("queued approval mail rechecks outlet approval and rebinds a current email", async () => {
  const db = baseDb({ "hotels/a/members/reader": { permissions: ["orders.approve"] }, "hotels/a/outlets/o/approvers/reader": {}, "hotels/a/orders/order": { status: "Created", outletId: "o" },
    "hotels/a/mailQueue/q": { hotelUid: "a", type: "order-approval", orderId: "order", recipientUids: ["reader"], status: "queued", payload: { to: ["old@example.test"], text: "fixture" } } });
  const event = { params: { hotelUid: "a", mailId: "q" }, data: { exists: true } }; const sent = [];
  const services = { firestore: db, auth: auth({ reader: user("reader", { email: "new@example.test" }) }), from: "app@example.test", send: async (p) => { sent.push(p); return { data: { id: "queued-id" } }; } };
  await processMailQueueHandler(event, services);
  assert.deepEqual(sent[0].to, ["new@example.test"]);
  assert.equal(db.rows.get("hotels/a/mailQueue/q").status, "sent");
  db.rows.delete("hotels/a/outlets/o/approvers/reader"); db.rows.get("hotels/a/mailQueue/q").status = "queued";
  await processMailQueueHandler(event, services);
  assert.equal(db.rows.get("hotels/a/mailQueue/q").status, "blocked"); assert.equal(sent.length, 1);
});

test("queued invitation requires the inviting operator's current enabled verified platform authority", async () => {
  const db = baseDb({ "hotels/a/members/invitee": { permissions: [] }, "hotels/a/mailQueue/i": { hotelUid: "a", type: "hotel-invitation", actorUid: "operator", uid: "invitee", status: "queued", payload: { to: ["invitee@example.test"], text: "fixture" } } });
  let sent = 0; const event = { params: { hotelUid: "a", mailId: "i" }, data: { exists: true } };
  const services = { firestore: db, auth: auth({ invitee: user("invitee", { emailVerified: false }), operator: user("operator", { customClaims: { platformAdmin: false } }) }), from: "app@example.test", send: async () => { sent += 1; return { data: { id: "invite" } }; } };
  await processMailQueueHandler(event, services); assert.equal(sent, 0); assert.equal(db.rows.get("hotels/a/mailQueue/i").status, "blocked");
  db.rows.get("hotels/a/mailQueue/i").status = "queued";
  services.auth = auth({ invitee: user("invitee", { emailVerified: false }), operator: user("operator", { customClaims: { platformAdmin: true } }) });
  await processMailQueueHandler(event, services); assert.equal(sent, 1);
});

test("a bounded research pass pauses and resumes remaining subjects without publishing partial results", async () => {
  const db = baseDb(); db.rows.delete(`${sourcePath}/r1`);
  for (let i = 0; i < 9; i += 1) db.rows.set(`${sourcePath}/r${i}`, guest(`Subject ${i}`));
  const requests = []; const fetchImpl = fetchResearch(requests);
  assert.equal((await processGuestIntelligenceForHotel("a", options(db, fetchImpl))).status, "checkpointed");
  assert.equal(requests.length, 8); assert.equal((await getLatestGuestIntelligence("a", db, NOW)).status, "unavailable");
  assert.equal((await processGuestIntelligenceForHotel("a", options(db, fetchImpl))).status, "completed");
  assert.equal(requests.length, 9); assert.equal((await getLatestGuestIntelligence("a", db, NOW)).guests.length, 9);
});

test("an expired lease is fenced so the original worker cannot overwrite a resumed completed run", async () => {
  const db = baseDb(); let clock = NOW; let release; let started;
  const startedPromise = new Promise((r) => { started = r; }); const wait = new Promise((r) => { release = r; });
  const first = processGuestIntelligenceForHotel("a", { db, token: "old", now: () => clock, fetchImpl: fetchResearch([], async () => { started(); await wait; }) });
  await startedPromise; clock += 10 * 60 * 1000;
  const resumed = await processGuestIntelligenceForHotel("a", { db, token: "new", now: () => clock, fetchImpl: fetchResearch([]) });
  assert.equal(resumed.status, "completed"); release(); await assert.rejects(first, /lease|retention/);
  assert.equal(db.rows.get(`hotels/a/guestIntelligenceRuns/${DATE}`).status, "completed");
  assert.equal((await getLatestGuestIntelligence("a", db, clock)).guests.length, 1);
});

test("two-hotel guest mail sends separate reports only to each hotel's current members", async () => {
  const db = baseDb({ "hotels/a/members/alice": { permissions: ["reservations.read"] }, "hotelSubscriptions/b": { status: "active" }, "hotels/b": { hotelName: "Hotel B" }, "hotels/b/members/bob": { permissions: ["reservations.read"] },
    [`hotels/b/reports/arrivalsmadeyesterday/${DATE}/r-b`]: guest("B Only Guest"), "scheduledMails/guestIntelligence": { hotelUid: ["a", "b"], recipientUidsByHotel: { a: ["alice"], b: ["bob"] } } });
  await processGuestIntelligenceForHotel("a", options(db, fetchResearch([]))); await processGuestIntelligenceForHotel("b", options(db, fetchResearch([])));
  const sent = [];
  await sendGuestIntelligenceMail({ firestore: db, auth: auth({ alice: user("alice"), bob: user("bob") }), now: () => NOW, from: "app@example.test", send: async (p) => { sent.push(p); return { data: { id: `m${sent.length}` } }; } });
  assert.equal(sent.length, 2); assert.deepEqual(sent[0].to, ["alice@example.test"]); assert.deepEqual(sent[1].to, ["bob@example.test"]);
  assert.match(sent[0].text, /Hotel A/); assert.doesNotMatch(sent[0].text, /Hotel B|B Only Guest/);
  assert.match(sent[1].text, /Hotel B|B Only Guest/); assert.doesNotMatch(sent[1].text, /Hotel A|Ada Lovelace/);
});


test("older occupancy schedule sends one hotel per authorized recipient set and uses stable source receipts", async () => {
  const db = baseDb({ "hotels/a/members/alice": { permissions: ["demandcalendar.read"] }, "hotelSubscriptions/b": { status: "active" }, "hotels/b/members/bob": { permissions: ["demandcalendar.read"] } });
  const sent = []; let builds = 0;
  const scheduleConfig = { hotelUid: ["a", "b"], recipientUidsByHotel: { a: ["alice"], b: ["bob"] }, mailto: ["legacy@example.test"] };
  const services = { firestore: db, auth: auth({ alice: user("alice"), bob: user("bob") }), now: () => NOW, from: "app@example.test", getOccupancyRows: async (hotelUid) => ({ hotelUid, hotelName: `Hotel ${hotelUid.toUpperCase()}`, rows: [] }),
    buildPdf: async () => Buffer.from(`pdf creation metadata ${builds++}`), buildExcel: async () => Buffer.from(`xlsx creation metadata ${builds++}`), send: async (p) => { sent.push(p); return { data: { id: `occupancy-${sent.length}` } }; } };
  await sendOccupancyMail({ scheduleConfig }, services); await sendOccupancyMail({ scheduleConfig }, services);
  assert.equal(sent.length, 2); assert.deepEqual(sent[0].to, ["alice@example.test"]); assert.deepEqual(sent[1].to, ["bob@example.test"]);
  assert.match(sent[0].text, /Hotel A/); assert.doesNotMatch(sent[0].text, /Hotel B/);
  assert.match(sent[1].text, /Hotel B/); assert.doesNotMatch(sent[1].text, /Hotel A/);
});

test("occupancy resolved failure is visible and cannot record a successful scheduled run", async () => {
  const db = baseDb({ "hotels/a/members/alice": { permissions: ["demandcalendar.read"] } });
  const services = { firestore: db, auth: auth({ alice: user("alice") }), now: () => NOW, from: "app@example.test", getOccupancyRows: async () => ({ hotelName: "Hotel A", rows: [] }), buildPdf: async () => Buffer.from("pdf"), buildExcel: async () => Buffer.from("xlsx"), send: async () => ({ error: { message: "Rejected" } }) };
  await assert.rejects(sendOccupancyMail({ scheduleConfig: { hotelUid: ["a"], recipientUidsByHotel: { a: ["alice"] } } }, services), /acknowledge/);
  assert.notEqual(db.rows.get("scheduledMails/scheduledOccupancyMail")?.lastRunStatus, "sent");
  assert.equal([...db.rows.values()].find((r) => r.deliveryKey?.startsWith("occupancy/"))?.status, "needs-review");
});

test("older block pickup schedule isolates hotels and rejects a provider response without an ID", async () => {
  const db = baseDb({ "hotels/a/members/alice": { permissions: ["groups.read"] }, "scheduledMails/scheduledBlockPickupMail": { hotelUids: ["a"], recipientUidsByHotel: { a: ["alice"] }, mailto: ["legacy@example.test"] } });
  const sent = [];
  const services = { firestore: db, auth: auth({ alice: user("alice") }), now: () => NOW, from: "app@example.test", getLatestSnapshotDate: async () => DATE, getHotelName: async () => "Hotel A", getGroups: async () => [{ description: "Group A", pickupSummaries: [{ allotmentDate: DATE, availableRooms: 5, pickupRooms: 2 }] }], send: async (p) => { sent.push(p); return { data: {} }; } };
  await assert.rejects(sendScheduledBlockPickupReportHandler(services), /acknowledge/);
  assert.deepEqual(sent[0].to, ["alice@example.test"]);
  assert.notEqual(db.rows.get("scheduledMails/scheduledBlockPickupMail").lastRunStatus, "sent");
  await assert.rejects(sendScheduledBlockPickupReportHandler(services), /Reconcile/); assert.equal(sent.length, 1);
});


test("ordinary hotel notification actor can complete a manual run and removal before claim blocks it", async () => {
  const db = baseDb({ "hotels/a/members/notifier": { permissions: ["contracts.notify", "contracts.read"] }, "hotels/a/contracts/c": { name: "Lease", cancelBefore: DATE, endDate: DATE, reminderDays: [0], followers: [{ id: "notifier" }] }, "hotels/a/contractReminderRuns/valid": { requestedBy: "notifier", status: "queued" } });
  let sends = 0;
  const services = { db, auth: auth({ notifier: user("notifier") }), now: new Date(NOW), from: "app@example.test", appBaseUrl: "https://example.test", send: async () => { sends += 1; return { data: { id: "manual-contract" } }; } };
  const event = (runId) => ({ data: { exists: true }, params: { hotelUid: "a", runId } });
  await runContractCancellationRemindersNowHandler(event("valid"), services);
  assert.equal(db.rows.get("hotels/a/contractReminderRuns/valid").status, "completed"); assert.equal(sends, 1);
  await runContractCancellationRemindersNowHandler(event("valid"), services); assert.equal(sends, 1);
  db.rows.delete("hotels/a/members/notifier"); db.rows.set("hotels/a/contractReminderRuns/removed", { requestedBy: "notifier", status: "queued" });
  await runContractCancellationRemindersNowHandler(event("removed"), services);
  assert.equal(db.rows.get("hotels/a/contractReminderRuns/removed").status, "blocked"); assert.equal(sends, 1);
});


test("research transport, response JSON and generated JSON failures cannot expose guest text through exceptions or logs", async () => {
  const privateText = "Fictional Name private professional profile excerpt";
  for (const fetchImpl of [async () => { throw new Error(privateText); }, async () => ({ ok: true, json: async () => { throw new Error(privateText); } }), async () => ({ ok: true, json: async () => ({ output_text: privateText }) })]) {
    await assert.rejects(researchGuests("fictional-key", "gpt-4.1-mini", [{ reservationId: "opaque", fullName: "Fictional Name" }], fetchImpl), (error) => {
      assert.equal(error.code, "guest-research-unavailable");
      assert.doesNotMatch(`${error.message}${error.stack}`, /Fictional|professional profile/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  const db = baseDb({ "scheduledReports/guestIntelligence": { hotelUid: ["a"] } }); const entries = [];
  await processNightlyGuestIntelligenceHandler({ db, processHotel: async () => { throw new Error(privateText); }, log: { info: () => {}, error: (...args) => entries.push(args) } });
  assert.equal(entries.length, 1); assert.doesNotMatch(JSON.stringify(entries), /Fictional|professional profile/);
  assert.deepEqual(entries[0][1], { hotelUid: "a", code: "guest-intelligence-failed" });
});

test("mail transport exceptions expose only a safe reconciliation code and journal ID", async () => {
  const db = baseDb(); const secret = "Fictional Guest full profile alice@example.test";
  await assert.rejects(deliverScheduledMail({ db, hotelUid: "a", deliveryKey: "unsafe-transport/day", payload: { text: secret }, send: async () => { throw new Error(secret); } }), (error) => {
    assert.equal(error.code, "mail-needs-review"); assert.match(error.receiptId, /^[a-f0-9]{64}$/); assert.equal(error.cause, undefined);
    assert.doesNotMatch(`${error.message}${error.stack}`, /Fictional|alice@example/); return true;
  });
  assert.doesNotMatch(JSON.stringify([...db.rows.values()].filter((r) => r.deliveryKey)), /Fictional|alice@example/);
});

test("guest source changed during Auth resolution is rejected inside the receipt claim without sending or creating a success journal", async () => {
  const db = baseDb({ "hotels/a/members/reader": { permissions: ["reservations.read"] }, "scheduledMails/guestIntelligence": { hotelUid: ["a"], recipientUidsByHotel: { a: ["reader"] } } });
  await processGuestIntelligenceForHotel("a", options(db, fetchResearch([])));
  let calls = 0;
  const currentAuth = { getUser: async (uid) => { db.rows.set(`${sourcePath}/r1`, guest("New Guest")); return user(uid); } };
  const result = await sendGuestIntelligenceMail({ firestore: db, auth: currentAuth, now: () => NOW, from: "app@example.test", send: async () => { calls += 1; return { data: { id: "should-not-send" } }; } });
  assert.equal(result[0].status, "source-unavailable"); assert.equal(calls, 0);
  assert.equal([...db.rows.keys()].some((key) => key.includes("/scheduledMailReceipts/")), false);
  assert.notEqual(db.rows.get("scheduledMails/guestIntelligence").lastRunStatus, "sent");
});

test("each required guest expiry independently fails closed when absent, malformed, invalid or elapsed", async () => {
  for (const location of ["run", "version", "row"]) {
    for (const expiry of [undefined, "tomorrow", new Date(Number.NaN), new Date(NOW), new Date(NOW + 10 * 86400000)]) {
      const db = baseDb(); const completed = await processGuestIntelligenceForHotel("a", options(db, fetchResearch([])));
      const path = location === "run" ? `hotels/a/guestIntelligenceRuns/${DATE}` : location === "version" ? `hotels/a/guestIntelligenceVersions/${completed.versionId}` : `hotels/a/guestIntelligenceVersions/${completed.versionId}/guests/r1`;
      if (expiry === undefined) delete db.rows.get(path).expiresAt; else db.rows.get(path).expiresAt = expiry;
      assert.equal((await getLatestGuestIntelligence("a", db, NOW)).status, "unavailable", `${location} must reject ${String(expiry)}`);
    }
  }
});

test("cleanup deletes expired or malformed date runs but preserves valid future expiry and bounded active leases", async () => {
  const db = baseDb({ "hotels/a/guestIntelligenceRuns/expired": { status: "completed", expiresAt: new Date(NOW), token: "retired" }, "hotels/a/guestIntelligenceRuns/missing": { status: "failed", token: "retired" }, "hotels/a/guestIntelligenceRuns/invalid": { expiresAt: new Date(Number.NaN), token: "retired" }, "hotels/a/guestIntelligenceRuns/future": { status: "completed", expiresAt: new Date(NOW + 1000) }, "hotels/a/guestIntelligenceRuns/active": { status: "processing", leaseUntil: new Date(NOW + 60000), expiresAt: new Date(NOW - 1), token: "active" }, "hotels/a/guestIntelligenceRuns/impossible-lease": { status: "processing", leaseUntil: new Date(NOW + 10 * 86400000), token: "retired" } });
  const result = await cleanupGuestIntelligenceForHotel("a", { db, now: () => NOW });
  assert.equal(result.removedRuns, 4);
  for (const id of ["expired", "missing", "invalid", "impossible-lease"]) assert.equal(db.rows.has(`hotels/a/guestIntelligenceRuns/${id}`), false);
  assert.equal(db.rows.has("hotels/a/guestIntelligenceRuns/future"), true); assert.equal(db.rows.has("hotels/a/guestIntelligenceRuns/active"), true);
  await cleanupGuestIntelligenceForHotel("a", { db, now: () => NOW + 60000 });
  assert.equal(db.rows.has("hotels/a/guestIntelligenceRuns/active"), false);
});

test("cleanup and a fresh same-date generation cannot reuse an expired version or its mail receipt", async () => {
  const db = baseDb({ "hotels/a/members/reader": { permissions: ["reservations.read"] }, "scheduledMails/guestIntelligence": { hotelUid: ["a"], recipientUidsByHotel: { a: ["reader"] } } });
  let clock = Date.parse("2026-10-09T22:30:00Z"); const requests = []; const fetchImpl = fetchResearch(requests);
  const first = await processGuestIntelligenceForHotel("a", { db, fetchImpl, now: () => clock });
  clock = Date.parse("2026-10-10T02:30:00Z"); const sent = []; const input = { firestore: db, auth: auth({ reader: user("reader") }), now: () => clock, from: "app@example.test", send: async (p) => { sent.push(p); return { data: { id: `generation-${sent.length}` } }; } };
  await sendGuestIntelligenceMail(input); assert.equal(sent.length, 1);
  clock = Date.parse("2026-10-10T21:30:00Z"); await cleanupGuestIntelligenceForHotel("a", { db, now: () => clock });
  assert.equal(db.rows.has(`hotels/a/guestIntelligenceRuns/${DATE}`), false);
  const next = await processGuestIntelligenceForHotel("a", { db, fetchImpl, now: () => clock });
  assert.notEqual(next.versionId, first.versionId); assert.equal(requests.length, 2);
  await sendGuestIntelligenceMail(input); assert.equal(sent.length, 2);
});

test("late completed guest research is mailed once after the original 04:30 delivery window", async () => {
  const db = baseDb({ "hotels/a/members/reader": { permissions: ["reservations.read"] }, "scheduledMails/guestIntelligence": { hotelUid: ["a"], recipientUidsByHotel: { a: ["reader"] } } });
  db.rows.delete(`${sourcePath}/r1`); for (let i = 0; i < 9; i += 1) db.rows.set(`${sourcePath}/r${i}`, guest(`Subject ${i}`));
  let clock = Date.parse("2026-10-10T01:00:00Z"); const fetchImpl = fetchResearch([]); const sent = [];
  assert.equal((await processGuestIntelligenceForHotel("a", { db, fetchImpl, now: () => clock })).status, "checkpointed");
  const input = { firestore: db, auth: auth({ reader: user("reader") }), now: () => clock, from: "app@example.test", send: async (p) => { sent.push(p); return { data: { id: "late-completed" } }; } };
  assert.equal((await sendGuestIntelligenceMail(input))[0].status, "delivery-window-closed");
  clock = Date.parse("2026-10-10T02:30:00Z"); assert.equal((await sendGuestIntelligenceMail(input))[0].status, "source-unavailable");
  clock = Date.parse("2026-10-10T03:00:00Z"); assert.equal((await processGuestIntelligenceForHotel("a", { db, fetchImpl, now: () => clock })).status, "completed");
  await sendGuestIntelligenceMail(input); await sendGuestIntelligenceMail(input); assert.equal(sent.length, 1);
});

test("a sent receipt with a missing, empty or nonstring acknowledgment never calls the provider again", async () => {
  for (const providerId of [undefined, null, "", " ", 123, { id: "invalid" }]) {
    const hotelUid = "a", deliveryKey = "corrupt-sent/day", payload = { text: "fixture" }, id = stableDigest([hotelUid, deliveryKey]);
    const db = baseDb({ [`hotels/${hotelUid}/scheduledMailReceipts/${id}`]: { hotelUid, deliveryKey, fingerprint: stableDigest(payload), status: "sent", providerId } }); let calls = 0;
    await assert.rejects(deliverScheduledMail({ db, hotelUid, deliveryKey, payload, send: async () => { calls += 1; return { data: { id: "would-duplicate" } }; } }), (error) => error.code === "mail-needs-review");
    assert.equal(calls, 0); assert.equal(db.rows.get(`hotels/${hotelUid}/scheduledMailReceipts/${id}`).status, "needs-review");
  }
});


test("logical mail and guest fingerprints remain stable across object map ordering", () => {
  assert.equal(stableDigest({ hotel: "a", guest: { name: "Ada", nights: 5 }, rows: [{ rooms: 2, date: DATE }] }),
    stableDigest({ rows: [{ date: DATE, rooms: 2 }], guest: { nights: 5, name: "Ada" }, hotel: "a" }));
  assert.notEqual(stableDigest({ rows: ["a", "b"] }), stableDigest({ rows: ["b", "a"] }));
  assert.equal(stableDigest({ expiresAt: new Date(NOW) }), stableDigest({ expiresAt: new Date(NOW) }));
});

test("a failed hotel's scheduled deliveries do not prevent another hotel's guest, occupancy, block or contract notifications", async () => {
  const privateText = "Private fictional guest profile alice@example.test";
  for (const kind of ["guest", "occupancy", "block", "contract"]) {
    const permissions = { guest: "reservations.read", occupancy: "demandcalendar.read", block: "groups.read", contract: "contracts.read" };
    const recipients = { a: ["alice"], b: ["bob"] };
    const db = baseDb({ "hotels/a/members/alice": { permissions: [permissions[kind]] }, "hotelSubscriptions/b": { status: "active" }, "hotels/b": { hotelName: "Hotel B" }, "hotels/b/members/bob": { permissions: [permissions[kind]] },
      [`hotels/b/reports/arrivalsmadeyesterday/${DATE}/r-b`]: guest("B Guest"),
      "scheduledMails/guestIntelligence": { hotelUid: ["a", "b"], recipientUidsByHotel: recipients }, "scheduledMails/scheduledBlockPickupMail": { hotelUids: ["a", "b"], recipientUidsByHotel: recipients },
      "hotels/a/contracts/c": { name: "Contract A", cancelBefore: DATE, reminderDays: [0], followers: [{ id: "alice" }] }, "hotels/b/contracts/c": { name: "Contract B", cancelBefore: DATE, reminderDays: [0], followers: [{ id: "bob" }] } });
    const attempts = [], logs = [];
    const services = { firestore: db, db, auth: auth({ alice: user("alice"), bob: user("bob") }), from: "app@example.test", appBaseUrl: "https://example.test", log: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) },
      send: async (payload) => { attempts.push(payload.to); if (payload.to.includes("alice@example.test")) throw new Error(privateText); return { data: { id: `${kind}-b-accepted` } }; } };
    let run;
    if (kind === "guest") {
      await processGuestIntelligenceForHotel("a", options(db, fetchResearch([]))); await processGuestIntelligenceForHotel("b", options(db, fetchResearch([])));
      run = () => sendGuestIntelligenceMail({ ...services, now: () => NOW });
    } else if (kind === "occupancy") {
      Object.assign(services, { now: () => NOW, getOccupancyRows: async (hotelUid) => ({ hotelUid, hotelName: `Hotel ${hotelUid}`, rows: [] }), buildPdf: async () => Buffer.from("pdf"), buildExcel: async () => Buffer.from("xlsx") });
      run = () => sendOccupancyMail({ scheduleConfig: { hotelUid: ["a", "b"], recipientUidsByHotel: recipients } }, services);
    } else if (kind === "block") {
      Object.assign(services, { now: () => NOW, getLatestSnapshotDate: async () => DATE, getHotelName: async (hotelUid) => `Hotel ${hotelUid}`, getGroups: async () => [{ pickupSummaries: [{ allotmentDate: DATE, availableRooms: 5, pickupRooms: 2 }] }] });
      run = () => sendScheduledBlockPickupReportHandler(services);
    } else {
      services.now = new Date(NOW); run = () => processContractCancellationReminders(services);
    }
    await assert.rejects(run(), (error) => error.code === "mail-partial-failure" && error.hotelFailures.length === 1 && error.hotelFailures[0].hotelUid === "a");
    assert.deepEqual(attempts, [["alice@example.test"], ["bob@example.test"]], kind);
    const receipts = [...db.rows.values()].filter((row) => row.deliveryKey);
    assert.equal(receipts.find((row) => row.hotelUid === "a").status, "needs-review", kind);
    assert.equal(receipts.find((row) => row.hotelUid === "b").status, "sent", kind);
    if (kind !== "contract") {
      const path = kind === "guest" ? "scheduledMails/guestIntelligence" : kind === "occupancy" ? "scheduledMails/scheduledOccupancyMail" : "scheduledMails/scheduledBlockPickupMail";
      assert.equal(db.rows.get(path).lastRunStatus, "partial-failure", kind);
    }
    assert.doesNotMatch(JSON.stringify(logs), /Private fictional|alice@example/);
    await assert.rejects(run(), (error) => error.code === "mail-partial-failure");
    assert.equal(attempts.length, 2, `${kind}: ambiguous hotel A and confirmed hotel B cannot resend`);
  }
});
