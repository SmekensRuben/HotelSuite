import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc, writeBatch } from "firebase/firestore";

let environment;
const currentQuote = { name: "Current quote", requestDate: "2026-10-10", startDate: "2027-04-01", endDate: "2027-04-02", groupSegment: "MICE", dateRangeSemantics: "CHECKOUT_EXCLUSIVE", quoteInputSchemaVersion: "group-quote-v3", roomsByDate: [{ date: "2027-04-01", rooms: 10, mealBasis: "RO", breakfastPax: 0, bqtRevenue: 0 }], groupCommissionPercentage: 10, analysisYears: [2025, 2024], displacementForecast: [], groupDemandForecast: [], integratedDisplacement: [], commercialStatus: "PENDING", quoteInputSnapshot: {}, analysisStatus: "CURRENT", analysisUnavailableReason: null, draft: false, analysisModelVersion: "group-contribution-v5-optimal-portfolio", contributionModelVersion: "group-contribution-v5-optimal-portfolio", stayPatternModelVersion: "stay-pattern-v1", displacementModelVersion: "los-network-v2-optimal-portfolio", marketContextModelVersion: "market-context-v1.2-source-horizon", pricingGuidanceModelVersion: "pricing-guidance-v2-input-guards", physicalFeasibilityVersion: "physical-feasibility-v2-required-inputs", physicalFeasibility: { status: "PHYSICALLY_FEASIBLE", requestedRoomNights: 10 }, marketContextSnapshot: {}, pricingGuidanceSnapshot: { targetRateInclVat: 200 }, sourceAvailabilitySnapshot: {}, analysisContributionSnapshot: { economicFloorRateInclVat: 150 }, legacyStayDateDisplacement: {}, losNetworkDisplacement: {} };
const base = "hotels/hotel-a/settings";
const permissions = {
  quote: ["groupquotes.read", "groupquotes.create", "groupquotes.update"],
  quoteObservation: ["groupquotes.*", "commercialintelligence.*"],
  revenue: ["groupquotes.read", "commercialintelligence.read", "commercialintelligence.update"],
  catalogCreate: ["catalogsettings.create"], catalogUpdate: ["catalogsettings.update"], catalogDelete: ["catalogsettings.delete"],
  contracts: ["contracts.settings"], operaCreate: ["integrations.create"], operaUpdate: ["integrations.update"], operaDelete: ["integrations.delete"],
  property: ["propertysettings.*"], upsells: ["auditupsells.settings"], none: [], stock: ["stockcounts.*"],
};
const database = (uid, claims = {}) => environment.authenticatedContext(uid, { email_verified: true, ...claims }).firestore();
const record = (db, path) => doc(db, path);
const seed = (callback) => environment.withSecurityRulesDisabled((context) => callback(context.firestore()));

before(async () => {
  environment = await initializeTestEnvironment({ projectId: "demo-hotel-suite-a00", firestore: { host: "127.0.0.1", port: 8080, rules: await readFile("firebase/firestore.rules", "utf8") } });
});
beforeEach(async () => {
  await environment.clearFirestore();
  await seed(async (db) => {
    await setDoc(record(db, "hotelSubscriptions/hotel-a"), { status: "active", validUntil: null });
    for (const [uid, keys] of Object.entries(permissions)) {
      await setDoc(record(db, `hotels/hotel-a/members/${uid}`), { permissions: keys });
      await setDoc(record(db, `users/${uid}`), { hotelUid: ["hotel-a"], disabled: false, permissions: [] });
    }
    for (const [path, data] of Object.entries({
      [`${base}/hotel-a`]: { operaUserMappings: { SECRET: "Private member" }, contractCategories: { private: "Confidential" } },
      [`${base}/bootstrap`]: { hotelName: "Fictional hotel", currency: "EUR" },
      [`${base}/propertySettings`]: { hotelRooms: 100 },
      [`${base}/groupQuotes`]: { roomVatPercentage: 21 },
      [`${base}/compset`]: { ownHotelLighthouseFieldName: "Own" },
      [`${base}/compset/competitors/kept`]: { displayName: "Kept", marketRelevanceWeight: 1 },
      [`${base}/catalog/categories/category`]: { name: "Existing" },
      [`${base}/catalog/subcategories/subcategory`]: { name: "Sub", categoryId: "category" },
      [`${base}/contracts/categories/category`]: { name: "Contracts" },
      [`${base}/opera/userMappings/OPERA`]: { operaUser: "OPERA", employeeName: "Employee" },
      [`${base}/upsells`]: { revenueTargetRules: [{ confidential: true }] },
      ["hotels/hotel-a/stockCounts/count"]: { status: "Finished", countedValue: 100, finishedBy: "canonical-actor" },
      ["hotels/hotel-a/stockCounts/count/locations/location"]: { status: "Finished", countedValue: 100 },
    })) await setDoc(record(db, path), data);
  });
});
after(() => environment.cleanup());

describe("isolated settings authority", () => {
  it("allows quote settings but denies quote-only mutations and reads in other private domains", async () => {
    const db = database("quote");
    await assertSucceeds(updateDoc(record(db, `${base}/groupQuotes`), { roomVatPercentage: 9 }));
    for (const [path, data] of Object.entries({
      [`${base}/hotel-a`]: { operaUserMappings: {} }, [`${base}/propertySettings`]: { hotelRooms: 1 },
      [`${base}/compset`]: { ownHotelLighthouseFieldName: "Tampered" }, [`${base}/catalog/categories/added`]: { name: "Added" },
      [`${base}/contracts/categories/added`]: { name: "Added" }, [`${base}/opera/userMappings/NEW`]: { operaUser: "NEW", employeeName: "Added" },
      [`${base}/upsells/occupancy/2026-10-10`]: { date: "2026-10-10", expectedOccupancy: 1 },
    })) await assertFails(setDoc(record(db, path), data));
    await assertFails(getDoc(record(db, `${base}/hotel-a`)));
    await assertFails(getDoc(record(db, `${base}/propertySettings`)));
    await assertFails(getDocs(collection(db, `${base}/contracts/categories`)));
    await assertFails(getDoc(record(db, `${base}/upsells`)));
  });
  it("denies private configuration to zero-permission, unverified and suspended identities", async () => {
    await assertSucceeds(getDoc(record(database("none"), `${base}/bootstrap`)));
    for (const path of [`${base}/hotel-a`, `${base}/groupQuotes`, `${base}/opera/userMappings/OPERA`, `${base}/upsells`]) {
      await assertFails(getDoc(record(database("none"), path)));
      await assertFails(getDoc(record(database("quote", { email_verified: false }), path)));
    }
    await seed((db) => setDoc(record(db, "hotelSubscriptions/hotel-a"), { status: "suspended", validUntil: null }));
    await assertSucceeds(getDoc(record(database("quote"), `${base}/bootstrap`)));
    await assertFails(getDoc(record(database("quote"), `${base}/groupQuotes`)));
    await assertFails(getDoc(record(database("property"), `${base}/propertySettings`)));
    await assertFails(getDoc(record(database("quote", { email_verified: false }), `${base}/bootstrap`)));
  });
  it("does not reopen legacy or settings schemas through the platform wildcard", async () => {
    const db = database("platform", { platformAdmin: true });
    await assertFails(getDoc(record(db, `${base}/hotel-a`)));
    await assertFails(setDoc(record(db, `${base}/groupQuotes`), { operaUserMappings: { unsafe: true } }));
    await assertFails(setDoc(record(db, `${base}/compset/competitors/invalid`), { displayName: "Invalid", marketRelevanceWeight: "not numeric" }));
  });
  it("enforces field, type and range schemas on create and update", async () => {
    const db = database("quote");
    await assertFails(updateDoc(record(db, `${base}/groupQuotes`), { roomVatPercentage: -1 }));
    await assertFails(updateDoc(record(db, `${base}/groupQuotes`), { roomVatPercentage: "21" }));
    await assertFails(updateDoc(record(db, `${base}/groupQuotes`), { defaultGroupMealBasis: "MAYBE" }));
    await assertFails(updateDoc(record(db, `${base}/groupQuotes`), { operaUserMappings: {} }));
    await assertFails(setDoc(record(database("upsells"), `${base}/upsells/occupancy/2026-10-10`), { date: "2026-10-10", expectedOccupancy: "100" }));
    await assertSucceeds(setDoc(record(database("upsells"), `${base}/upsells/occupancy/2026-10-10`), { date: "2026-10-10", expectedOccupancy: 100 }));
  });
});

describe("functional revenue and action contracts", () => {
  it("allows ordinary revenue users on the actual compset path and atomically rejects a bad child", async () => {
    const db = database("revenue");
    await assertSucceeds(getDoc(record(db, `${base}/compset`)));
    await assertSucceeds(getDocs(collection(db, `${base}/compset/competitors`)));
    let batch = writeBatch(db);
    batch.set(record(db, `${base}/compset`), { ownHotelLighthouseFieldName: "Changed", lighthouseRateBasis: "INCL_VAT_CONSUMER" });
    batch.set(record(db, `${base}/compset/competitors/new`), { displayName: "New", marketRelevanceWeight: 2 });
    await assertSucceeds(batch.commit());
    batch = writeBatch(db);
    batch.update(record(db, `${base}/compset`), { ownHotelLighthouseFieldName: "Partial" });
    batch.set(record(db, `${base}/compset/competitors/invalid`), { displayName: "Invalid", marketRelevanceWeight: -1 });
    await assertFails(batch.commit());
    assert.equal((await getDoc(record(db, `${base}/compset`))).data().ownHotelLighthouseFieldName, "Changed");
    assert.equal((await getDoc(record(db, `${base}/compset/competitors/invalid`))).exists(), false);
  });
  it("applies catalog create/update/delete roles to the matching record action", async () => {
    for (const [uid, action] of [["catalogCreate", "create"], ["catalogUpdate", "update"], ["catalogDelete", "delete"]]) {
      const db = database(uid);
      await assertSucceeds(getDocs(collection(db, `${base}/catalog/categories`)));
      const create = () => setDoc(record(db, `${base}/catalog/categories/${uid}`), { name: "Created" });
      const update = () => updateDoc(record(db, `${base}/catalog/categories/category`), { name: "Updated" });
      const remove = () => deleteDoc(record(db, `${base}/catalog/subcategories/subcategory`));
      for (const [operation, execute] of [["create", create], ["update", update], ["delete", remove]]) await (operation === action ? assertSucceeds : assertFails)(execute());
    }
    assert.equal((await getDoc(record(database("catalogDelete"), `${base}/catalog/subcategories/subcategory`))).exists(), false);
    assert.equal((await getDoc(record(database("catalogDelete"), `${base}/catalog/categories/category`))).exists(), true);
  });
  it("uses contracts.settings for taxonomy mutations and persists record deletion", async () => {
    const db = database("contracts");
    await assertSucceeds(setDoc(record(db, `${base}/contracts/categories/added`), { name: "Added" }));
    await assertSucceeds(updateDoc(record(db, `${base}/contracts/categories/added`), { name: "Updated" }));
    await assertSucceeds(deleteDoc(record(db, `${base}/contracts/categories/added`)));
    assert.equal((await getDoc(record(db, `${base}/contracts/categories/added`))).exists(), false);
    assert.equal((await getDoc(record(db, `${base}/contracts/categories/category`))).data().name, "Contracts");
  });
  it("keeps Opera action roles separate and cannot spoof or rename another username", async () => {
    await assertSucceeds(setDoc(record(database("operaCreate"), `${base}/opera/userMappings/NEW`), { operaUser: "NEW", employeeName: "New" }));
    await assertFails(setDoc(record(database("operaCreate"), `${base}/opera/userMappings/SPOOF`), { operaUser: "OPERA", employeeName: "Changed" }));
    await assertFails(updateDoc(record(database("operaCreate"), `${base}/opera/userMappings/OPERA`), { employeeName: "Changed" }));
    await assertSucceeds(updateDoc(record(database("operaUpdate"), `${base}/opera/userMappings/OPERA`), { employeeName: "Updated" }));
    await assertFails(updateDoc(record(database("operaUpdate"), `${base}/opera/userMappings/OPERA`), { operaUser: "NEW" }));
    await assertFails(deleteDoc(record(database("operaUpdate"), `${base}/opera/userMappings/OPERA`)));
    await assertSucceeds(deleteDoc(record(database("operaDelete"), `${base}/opera/userMappings/NEW`)));
    assert.equal((await getDoc(record(database("operaDelete"), `${base}/opera/userMappings/NEW`))).exists(), false);
    assert.equal((await getDoc(record(database("operaDelete"), `${base}/opera/userMappings/OPERA`))).data().employeeName, "Updated");
  });
  it("lets a settings-only upsell operator read Opera mappings without unrelated configuration", async () => {
    const db = database("upsells");
    await assertSucceeds(getDocs(collection(db, `${base}/opera/userMappings`)));
    await assertFails(getDoc(record(db, `${base}/propertySettings`)));
    await assertFails(getDocs(collection(db, `${base}/contracts/categories`)));
  });
  it("reads anonymous model root and years while denying raw reservations and client model publication", async () => {
    const root = "hotels/hotel-a/reports/stayPatternModel";
    const annual = `${root}/years/2025`;
    const raw = "hotels/hotel-a/reports/staydatepattern/2027-04-01/reservation-1";
    const reminder = "hotels/hotel-a/contractReminderRuns/run";
    await seed(async (db) => {
      await setDoc(record(db, root), { status: "VALID", modelVersion: "stay-pattern-v1" });
      await setDoc(record(db, annual), { status: "VALID", roomNights: 100 });
      await setDoc(record(db, raw), { guestName: "Private guest", email: "private@example.invalid" });
      await setDoc(record(db, reminder), { status: "processing", requestedBy: "worker-authority" });
    });
    const quoteDb = database("quote");
    await assertSucceeds(getDoc(record(quoteDb, root)));
    await assertSucceeds(getDoc(record(quoteDb, annual)));
    await assertSucceeds(getDocs(collection(quoteDb, `${root}/years`)));
    await assertFails(getDoc(record(quoteDb, raw)));
    await assertFails(getDocs(collection(quoteDb, "hotels/hotel-a/reports/staydatepattern/2027-04-01")));
    for (const db of [quoteDb, database("platform", { platformAdmin: true })]) {
      await assertFails(updateDoc(record(db, root), { status: "VALID", sourceFingerprint: "forged" }));
      await assertFails(setDoc(record(db, `${root}/years/2026`), { status: "VALID", roomNights: 1 }));
      await assertFails(deleteDoc(record(db, annual)));
      await assertFails(updateDoc(record(db, reminder), { status: "complete" }));
      await assertFails(deleteDoc(record(db, reminder)));
    }
  });
  it("denies direct finished stock parent and child tampering, including platform identities", async () => {
    for (const db of [database("stock"), database("platform", { platformAdmin: true })]) {
      for (const path of ["hotels/hotel-a/stockCounts/count", "hotels/hotel-a/stockCounts/count/locations/location"]) {
        await assertFails(updateDoc(record(db, path), { status: "In Progress", countedValue: 1, finishedBy: "forged" }));
        await assertFails(deleteDoc(record(db, path)));
      }
    }
  });
  it("permits an explicit unavailable draft but rejects malformed quote and product fields", async () => {
    const db = database("quote");
    const valid = { name: "Unavailable draft", startDate: "2027-04-01", endDate: "2027-04-02", roomsByDate: [{ date: "2027-04-01", rooms: 10 }], analysisStatus: "UNAVAILABLE", analysisUnavailableReason: "Sources unavailable", draft: true };
    await assertSucceeds(setDoc(record(db, "hotels/hotel-a/quotes/draft"), valid));
    await assertSucceeds(updateDoc(record(db, "hotels/hotel-a/quotes/draft"), { name: "Renamed draft" }));
    await assertFails(updateDoc(record(db, "hotels/hotel-a/quotes/draft"), { roomsByDate: "corrupt" }));
    await assertFails(setDoc(record(db, "hotels/hotel-a/quotes/invalid"), { ...valid, name: "x".repeat(301) }));
    await assertFails(setDoc(record(db, "hotels/hotel-a/quotes/unknown"), { ...valid, analysisStatus: "UNKNOWN" }));
    await assertFails(setDoc(record(db, "hotels/hotel-a/quotes/falsely-current"), { ...valid, analysisStatus: "CURRENT", draft: false }));
    await assertFails(setDoc(record(db, "hotels/hotel-a/quotes/falsely-priced-draft"), { ...valid, draft: false, pricingGuidanceSnapshot: { targetRateInclVat: 200 } }));
    await assertFails(setDoc(record(db, "hotels/hotel-a/quotes/no-unavailable-reason"), { ...valid, analysisUnavailableReason: "" }));
    await assertFails(setDoc(record(db, "hotels/hotel-a/quotes/zero-room-current"), { ...currentQuote, roomsByDate: [{ date: "2027-04-01", rooms: 0 }], physicalFeasibility: { status: "PHYSICALLY_FEASIBLE", requestedRoomNights: 0 } }));
    await assertFails(setDoc(record(db, "hotels/hotel-a/quotes/infinite-room-current"), { ...currentQuote, physicalFeasibility: { status: "PHYSICALLY_FEASIBLE", requestedRoomNights: Infinity } }));
    await assertFails(setDoc(record(database("platform", { platformAdmin: true }), "hotels/hotel-a/catalogproducts/invalid"), { name: "Product", active: "true" }));
  });
  it("accepts a fully populated quote create, stale edit and saved outcome within the expression budget", async () => {
    const db = database("quote");
    const payload = currentQuote;
    const reference = record(db, "hotels/hotel-a/quotes/current");
    await assertSucceeds(setDoc(reference, payload));
    await assertSucceeds(updateDoc(reference, { analysisStatus: "STALE", analysisStaleReason: "QUOTE_INPUTS_CHANGED", groupCommissionPercentage: 12 }));
    await assertSucceeds(updateDoc(reference, { commercialStatus: "LOST", outcome: { status: "LOST", finalQuotedRateInclVat: 199, competitorQuotedRateInclVat: null }, rateHistory: [{ rateInclVat: 199 }] }));
    await assertFails(updateDoc(reference, { analysisModelVersion: "silent-replacement", analysisContributionSnapshot: { economicFloorRateInclVat: 1 } }));
    await assertFails(updateDoc(reference, { analysisStatus: "CURRENT" }));
  });
  it("requires stale or unavailable status for every changed analysis or saved-snapshot input", async () => {
    const db = database("quote");
    const reference = record(db, "hotels/hotel-a/quotes/current");
    await assertSucceeds(setDoc(reference, currentQuote));
    const changes = {
      startDate: "2027-03-31", endDate: "2027-04-03", roomsByDate: [{ date: "2027-04-01", rooms: 11 }],
      breakfastPax: 20, groupCommissionPercentage: 12, analysisYears: [2026], requestDate: "2026-10-09",
      groupSegment: "LEISURE", dateRangeSemantics: "LEGACY_INCLUSIVE", quoteInputSchemaVersion: "group-quote-v4",
    };
    for (const [key, value] of Object.entries(changes)) {
      await assertFails(updateDoc(reference, { [key]: value }));
      await assertFails(updateDoc(reference, { [key]: value, analysisStatus: "CURRENT" }));
    }
    await assertSucceeds(updateDoc(reference, { name: "Renamed", commercialStatus: "PENDING" }));
    await assertSucceeds(updateDoc(reference, { ...changes, analysisStatus: "STALE", analysisStaleReason: "QUOTE_INPUTS_CHANGED" }));
    await assertSucceeds(updateDoc(reference, { groupSegment: "CORPORATE", analysisStatus: "UNAVAILABLE" }));
    const saved = (await getDoc(reference)).data();
    assert.deepEqual(saved.analysisContributionSnapshot, currentQuote.analysisContributionSnapshot);
    assert.deepEqual(saved.quoteInputSnapshot, currentQuote.quoteInputSnapshot);
    assert.equal(saved.analysisModelVersion, currentQuote.analysisModelVersion);
  });
  it("saves quote-only outcomes and commits optional permitted observations without partial outcomes", async () => {
    const quoteDb = database("quote");
    const quotePath = "hotels/hotel-a/quotes/current";
    const observationPath = "hotels/hotel-a/competitorGroupQuotes/current_kept";
    await assertSucceeds(setDoc(record(quoteDb, quotePath), currentQuote));
    const observation = { competitorId: "kept", sourceType: "LOST_GROUP", sourceQuoteId: "current", competitorQuotedRateInclVat: 229, mealBasis: "UNKNOWN", occupancyBasis: "UNKNOWN", sourceConfidence: "LOW" };
    let batch = writeBatch(quoteDb);
    batch.update(record(quoteDb, quotePath), { commercialStatus: "LOST", outcome: { status: "LOST", competitorQuotedRateInclVat: 229 } });
    batch.set(record(quoteDb, observationPath), observation);
    await assertFails(batch.commit());
    assert.equal((await getDoc(record(quoteDb, quotePath))).data().commercialStatus, "PENDING");
    await assertSucceeds(updateDoc(record(quoteDb, quotePath), { commercialStatus: "LOST", outcome: { status: "LOST", competitorQuotedRateInclVat: 229 } }));
    const coupledDb = database("quoteObservation");
    assert.equal((await getDoc(record(coupledDb, observationPath))).exists(), false);
    batch = writeBatch(coupledDb);
    batch.update(record(coupledDb, quotePath), { outcome: { status: "LOST", competitorQuotedRateInclVat: 230 } });
    batch.set(record(coupledDb, observationPath), { ...observation, competitorQuotedRateInclVat: 230 });
    await assertSucceeds(batch.commit());
    assert.equal((await getDoc(record(coupledDb, quotePath))).data().outcome.competitorQuotedRateInclVat, 230);
    assert.equal((await getDoc(record(coupledDb, observationPath))).data().competitorQuotedRateInclVat, 230);
  });
});
