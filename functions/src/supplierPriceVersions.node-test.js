const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("./productPolicy");
const { pricingTerms, priceTermsChanged, canonicalPrice } = require("./supplierPricePolicy");
const { normalizePriceEvidence, assessSourceFreshness, loadSupplierPriceVersions, resolveSupplierPriceVersion,
  prepareSupplierPriceVersion, writeSupplierPriceVersion, MAX_PRICE_VERSIONS, MAX_PRICE_CONFIRMATIONS } = require("./supplierPriceVersions");
const catalog = { baseUnit: "l" };
const offer = (patch = {}) => policy.normalizeSupplierProduct({ supplierId: "supplier", supplierSku: "JUICE6", supplierProductName: "Juice six pack",
  currency: "EUR", priceBasis: "net", vatRate: null, pricingModel: "Per Purchase Unit", baseUnit: "l", purchaseUnit: "Case", baseUnitsPerPurchaseUnit: 6,
  pricePerPurchaseUnit: 12, pricePerBaseUnit: null, catalogProductId: "juice", active: true, purchaseOptions: [], ...patch });
const source = (patch = {}) => ({ kind: "supplier-list", confirmsUnitPrice: true, providedPriceOptionIds: ["default"],
  sourceReference: "Supplier October.xlsx · row-8", sourceIssuedOn: "2026-10-01", sourceImportId: "job", sourceProposalId: "row-8", ...patch });
function database() {
  const records = new Map();
  const db = { records, doc: (path) => ({ path }), collection: (path) => ({ limit: (maximum) => ({ path, maximum, isQuery: true }) }) };
  const tx = { get: async (ref) => ({ docs: [...records].filter(([path]) => path.startsWith(ref.path + "/") && !path.slice(ref.path.length + 1).includes("/"))
    .slice(0, ref.maximum).map(([path, data]) => ({ id: path.split("/").at(-1), data: () => structuredClone(data) })) }),
  create: (ref, data) => { assert.equal(records.has(ref.path), false, "immutable evidence cannot be overwritten"); records.set(ref.path, structuredClone(data)); } };
  return { db, tx };
}
async function approve(context, previous, next, evidence, day = "2026-10-14") {
  const expected = previous?.revision ?? 0;
  const versions = await loadSupplierPriceVersions(context.tx, context.db, "hotel", "product");
  const plan = { productId: "product", expected, previous, next, catalog, previousCatalog: previous ? catalog : null,
    priceChanged: priceTermsChanged(previous, next, previous ? catalog : null, catalog) };
  prepareSupplierPriceVersion(plan, versions, evidence, day);
  const now = { seconds: Date.parse(day + "T12:00:00Z") / 1000 };
  writeSupplierPriceVersion(context.tx, context.db, "hotel", plan, "buyer", now);
  return { ...plan.next, revision: expected + 1 };
}
const resolve = async (context, product, date, patch = {}) => resolveSupplierPriceVersion(product,
  await loadSupplierPriceVersions(context.tx, context.db, "hotel", "product"), { orderDate: date, pricingDateBasis: "order-date", ...patch });
const count = (context, namespace) => [...context.db.records.keys()].filter((path) => path.includes(`/${namespace}/`)).length;

test("scheduled supplier terms retain today's package and price, switch inclusively, and never mutate historic evidence", async () => {
  const context = database();
  const current = await approve(context, null, offer({ priceValidFrom: "2026-10-01", priceValidUntil: null }), source());
  const before = structuredClone([...context.db.records]);
  const future = await approve(context, current, offer({ pricePerPurchaseUnit: 18, baseUnitsPerPurchaseUnit: 3, priceValidFrom: "2026-11-01", priceValidUntil: "2026-11-30" }),
    source({ sourceIssuedOn: "2026-10-10", sourceReference: "November.xlsx · row-8" }));
  assert.equal(future.pricePerPurchaseUnit, 12); assert.equal(future.baseUnitsPerPurchaseUnit, 6);
  assert.equal((await resolve(context, future, "2026-10-31")).product.pricePerPurchaseUnit, 12);
  const applicable = await resolve(context, future, "2026-11-01");
  assert.equal(applicable.product.pricePerPurchaseUnit, 18); assert.equal(applicable.product.baseUnitsPerPurchaseUnit, 3);
  assert.equal(applicable.sourceReference, "November.xlsx · row-8"); assert.equal(applicable.priceValidity, "current");
  assert.equal((await resolve(context, future, "2026-11-30")).product.pricePerPurchaseUnit, 18);
  const expired = await resolve(context, future, "2026-12-01");
  assert.equal(expired.priceValidity, "expired"); assert.equal(expired.product.pricePerPurchaseUnit, null, "expired agreement cannot revive an earlier open-ended price");
  for (const [path, evidence] of before) assert.deepEqual(context.db.records.get(path), evidence);
});

test("legacy current terms get an honest immutable baseline before a future agreement", async () => {
  const context = database(), legacy = { ...offer(), revision: 7 };
  const projected = await approve(context, legacy, offer({ pricePerPurchaseUnit: 20, priceValidFrom: "2026-11-01" }), source());
  assert.equal(projected.pricePerPurchaseUnit, 12);
  const versions = await loadSupplierPriceVersions(context.tx, context.db, "hotel", "product");
  const prior = versions.find((version) => version.observation === "retained-prior-terms");
  assert.equal(prior.approvedAt, null); assert.equal(prior.lastPriceConfirmedAt, null); assert.equal(prior.productTerms.priceValidFrom, null);
  assert.equal((await resolve(context, projected, "2026-10-14")).product.pricePerPurchaseUnit, 12);
  assert.equal((await resolve(context, projected, "2026-11-01")).product.pricePerPurchaseUnit, 20);
});

test("a new future-only offer is unavailable now and order versus delivery agreements select different versions", async () => {
  const context = database();
  const product = await approve(context, null, offer({ priceValidFrom: "2026-11-01" }), source());
  assert.equal(product.pricePerPurchaseUnit, null);
  const order = await resolve(context, product, "2026-10-30", { deliveryDate: "2026-11-01" });
  const delivery = await resolve(context, product, "2026-10-30", { deliveryDate: "2026-11-01", pricingDateBasis: "delivery-date" });
  assert.equal(order.priceValidity, "future"); assert.equal(order.product.pricePerPurchaseUnit, null);
  assert.equal(delivery.priceValidity, "current"); assert.equal(delivery.product.pricePerPurchaseUnit, 12); assert.equal(delivery.pricingDate, "2026-11-01");
  await assert.rejects(resolve(context, product, "2026-10-30", { pricingDateBasis: "delivery-date" }), /delivery business date/);
});

test("reconfirmation appends source evidence without changing approved version, terms or last change", async () => {
  const context = database();
  const current = await approve(context, null, offer(), source(), "2026-10-02");
  const originalVersions = [...context.db.records].filter(([path]) => path.includes("/supplierPriceVersions/"));
  const repeated = await approve(context, current, offer(), source({ sourceIssuedOn: "2026-10-10", sourceReference: "Confirmed October.xlsx · row-8" }), "2026-10-14");
  assert.equal(count(context, "supplierPriceVersions"), 1); assert.equal(count(context, "supplierPriceConfirmations"), 2);
  assert.equal(repeated.currentPriceVersionId, current.currentPriceVersionId);
  assert.deepEqual(repeated.priceUpdatedOn, current.priceUpdatedOn); assert.notDeepEqual(repeated.priceConfirmedOn, current.priceConfirmedOn);
  for (const [path, evidence] of originalVersions) assert.deepEqual(context.db.records.get(path), evidence);
  const result = await resolve(context, repeated, "2026-10-14");
  assert.equal(result.sourceReference, "Supplier October.xlsx · row-8", "the approved agreement source stays stable for frozen order signatures");
  assert.equal(result.latestConfirmationSourceReference, "Confirmed October.xlsx · row-8");
  assert.deepEqual(result.lastPriceConfirmedAt, repeated.priceConfirmedOn);
});

test("scheduled reconfirmations retain current confirmation and update the future version's projected evidence", async () => {
  const context = database();
  const current = await approve(context, null, offer(), source(), "2026-10-02");
  const nextTerms = offer({ pricePerPurchaseUnit: 20, priceValidFrom: "2026-11-01" });
  const scheduled = await approve(context, current, nextTerms, source({ sourceIssuedOn: "2026-10-05" }), "2026-10-05");
  const repeated = await approve(context, scheduled, nextTerms, source({ sourceIssuedOn: "2026-10-10", sourceReference: "Reconfirmed November.xlsx" }), "2026-10-14");
  assert.equal(count(context, "supplierPriceVersions"), 2);
  assert.deepEqual(repeated.priceConfirmedOn, current.priceConfirmedOn);
  const future = await resolve(context, repeated, "2026-11-01");
  assert.equal(future.latestConfirmationSourceReference, "Reconfirmed November.xlsx");
  assert.deepEqual(future.lastPriceConfirmedAt, { seconds: Date.parse("2026-10-14T12:00:00Z") / 1000 });
});

test("statistics and product-only documents cannot change or reconfirm existing unit prices", async () => {
  const context = database();
  const current = await approve(context, null, offer(), source(), "2026-10-02");
  const updated = await approve(context, current, offer({ supplierProductName: "Renamed", pricePerPurchaseUnit: 999 }),
    source({ confirmsUnitPrice: false, providedPriceOptionIds: [], sourceIssuedOn: "2026-10-14" }));
  assert.equal(updated.supplierProductName, "Renamed"); assert.equal(updated.pricePerPurchaseUnit, 12);
  assert.deepEqual(updated.priceConfirmedOn, current.priceConfirmedOn); assert.deepEqual(updated.priceUpdatedOn, current.priceUpdatedOn);
  assert.equal(updated.latestPriceSourceIssuedOn, "2026-10-01"); assert.equal(count(context, "supplierPriceConfirmations"), 1);
  assert.equal(count(context, "supplierPriceVersions"), 1);
});

test("explicit reviewed corrections remain approved but do not pretend to have new source confirmation", async () => {
  const context = database();
  const current = await approve(context, null, offer(), source(), "2026-10-02");
  const updated = await approve(context, current, offer({ pricePerPurchaseUnit: 16 }), source({ confirmsUnitPrice: false, providedPriceOptionIds: [], allowPriceChange: true }));
  assert.equal(updated.pricePerPurchaseUnit, 16); assert.equal(count(context, "supplierPriceVersions"), 2);
  assert.deepEqual(updated.priceConfirmedOn, current.priceConfirmedOn);
  const resolved = await resolve(context, updated, "2026-10-14");
  assert.equal(resolved.optionReliability.default.confirmationMatchesCurrentTerms, false);
  assert.ok(resolved.optionsNeedingReview.includes("default"));
});

test("a default package source never refreshes the last confirmation for preserved package options", async () => {
  const context = database();
  const single = { id: "bottle", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 2 };
  const current = await approve(context, null, offer({ purchaseOptions: [single] }), undefined, "2026-10-02");
  const defaultConfirmed = await approve(context, current, offer({ pricePerPurchaseUnit: 15, purchaseOptions: [single] }), source(), "2026-10-14");
  assert.deepEqual(defaultConfirmed.priceOptionReliability.bottle.lastPriceConfirmedAt, current.priceOptionReliability.bottle.lastPriceConfirmedAt);
  assert.notDeepEqual(defaultConfirmed.priceOptionReliability.default.lastPriceConfirmedAt, current.priceOptionReliability.default.lastPriceConfirmedAt);
  assert.equal(defaultConfirmed.priceOptionReliability.bottle.confirmationMatchesCurrentTerms, true);
});

test("older sources cannot overwrite or reconfirm a newer reviewed source, including scheduled agreements", async () => {
  const context = database();
  const current = await approve(context, null, offer(), source({ sourceIssuedOn: "2026-10-10" }));
  const before = structuredClone([...context.db.records]);
  await assert.rejects(approve(context, current, offer({ pricePerPurchaseUnit: 1 }), source({ sourceIssuedOn: "2026-10-01" })), /older than a reviewed agreement/);
  await assert.rejects(approve(context, current, offer(), source({ sourceIssuedOn: "2026-10-01" })), /older than a reviewed agreement/);
  assert.deepEqual([...context.db.records], before);
  assert.equal(assessSourceFreshness(null, "2026-10-10"), "unknown");
  assert.equal(assessSourceFreshness("2026-10-10", "2026-10-10"), "current");
});

test("unknown contractual validity, source dates and supplier agreements remain explicitly reviewable", async () => {
  const context = database();
  const product = await approve(context, null, offer(), source({ sourceIssuedOn: null }));
  const resolved = await resolve(context, product, "2026-10-14", { pricingDateBasis: undefined });
  assert.equal(resolved.priceValidity, "unknown"); assert.equal(resolved.pricingAgreementKnown, false);
  assert.ok(resolved.reasons.includes("price-validity-unknown")); assert.ok(resolved.reasons.includes("price-source-date-unknown"));
  assert.ok(resolved.reasons.includes("supplier-pricing-date-agreement-unknown")); assert.equal(resolved.product.pricePerPurchaseUnit, 12);
});

test("same box price with smaller contents is a real physical-unit price increase", async () => {
  const context = database();
  const current = await approve(context, null, offer(), source());
  const changed = await approve(context, current, offer({ baseUnitsPerPurchaseUnit: 3 }), source({ sourceIssuedOn: "2026-10-14" }));
  const beforeTerms = pricingTerms(current, catalog), afterTerms = pricingTerms(changed, catalog);
  assert.equal(canonicalPrice(beforeTerms, beforeTerms.options[0]).netPricePerCatalogUnit, 2);
  assert.equal(canonicalPrice(afterTerms, afterTerms.options[0]).netPricePerCatalogUnit, 4);
  assert.equal(count(context, "supplierPriceVersions"), 2);
});

test("bounded immutable evidence, malformed versions and invalid dates fail explicitly", async () => {
  const context = database();
  await approve(context, null, offer(), source());
  const versions = await loadSupplierPriceVersions(context.tx, context.db, "hotel", "product");
  assert.throws(() => resolveSupplierPriceVersion(offer(), versions, { orderDate: "2026-02-30" }), /business date/);
  assert.throws(() => normalizePriceEvidence(source({ sourceIssuedOn: "2026-02-30" })), /source date/);
  assert.throws(() => normalizePriceEvidence(source({ providedPriceOptionIds: ["default", "default"] })), /proven purchase options/);
  const entries = [...context.db.records].filter(([path]) => path.includes("/supplierPriceVersions/"));
  const [path, version] = entries[0];
  context.db.records.set(path, { ...version, supplierProductId: "foreign" });
  await assert.rejects(loadSupplierPriceVersions(context.tx, context.db, "hotel", "product"), /evidence needs review/);
  context.db.records.set(path, version);
  for (let index = 0; index < MAX_PRICE_VERSIONS; index++) context.db.records.set(`hotels/hotel/supplierPriceVersions/product/entries/extra-${index}`, version);
  await assert.rejects(loadSupplierPriceVersions(context.tx, context.db, "hotel", "product"), /supported version window/);
  for (const key of [...context.db.records.keys()].filter((key) => key.includes("/supplierPriceVersions/") && key !== path)) context.db.records.delete(key);
  const confirmation = [...context.db.records].find(([key]) => key.includes("/supplierPriceConfirmations/"))[1];
  for (let index = 0; index < MAX_PRICE_CONFIRMATIONS; index++) context.db.records.set(`hotels/hotel/supplierPriceConfirmations/product/entries/extra-${index}`, confirmation);
  await assert.rejects(loadSupplierPriceVersions(context.tx, context.db, "hotel", "product"), /supported evidence window/);
});

test("a dated unchanged-price confirmation resolves source uncertainty without rewriting approval provenance", async () => {
  const context = database();
  const original = await approve(context, null, offer({ priceValidFrom: "2026-10-01" }), undefined, "2026-10-02");
  assert.ok((await resolve(context, original, "2026-10-14")).reasons.includes("price-source-date-unknown"));
  const confirmed = await approve(context, original, offer({ priceValidFrom: "2026-10-01" }), source(), "2026-10-14");
  const current = await resolve(context, confirmed, "2026-10-14");
  assert.equal(current.sourceReference, "Manual product review"); assert.equal(current.sourceIssuedOn, null);
  assert.equal(current.latestConfirmationSourceReference, "Supplier October.xlsx · row-8");
  assert.equal(current.latestConfirmationSourceIssuedOn, "2026-10-01");
  assert.equal(current.needsReview, false);
});

test("a newly reviewed active agreement replaces an older undated price even when its stated start precedes review", async () => {
  const context = database();
  const original = await approve(context, null, offer(), undefined, "2026-10-14");
  const updated = await approve(context, original, offer({ pricePerPurchaseUnit: 18, priceValidFrom: "2026-10-01" }), source({ sourceIssuedOn: "2026-10-14" }), "2026-10-20");
  assert.equal(updated.pricePerPurchaseUnit, 18);
  assert.equal((await resolve(context, updated, "2026-10-20")).product.pricePerPurchaseUnit, 18);
});

test("interim current-price corrections do not erase a previously approved future agreement", async () => {
  const context = database();
  const original = await approve(context, null, offer(), undefined, "2026-10-14");
  const pending = await approve(context, original, offer({ pricePerPurchaseUnit: 20, priceValidFrom: "2026-11-01" }), source(), "2026-10-14");
  const interim = await approve(context, pending, offer({ pricePerPurchaseUnit: 15 }), undefined, "2026-10-20");
  assert.equal(interim.pricePerPurchaseUnit, 15);
  assert.equal((await resolve(context, interim, "2026-10-31")).product.pricePerPurchaseUnit, 15);
  assert.equal((await resolve(context, interim, "2026-11-01")).product.pricePerPurchaseUnit, 20);
});

test("renewing unchanged unit prices and validity periods advances confirmation while retaining the last economic price change", async () => {
  const context = database();
  const original = await approve(context, null, offer({ priceValidFrom: "2026-10-01", priceValidUntil: "2026-10-31" }), source(), "2026-10-02");
  const renewed = await approve(context, original, offer({ priceValidFrom: "2026-11-01", priceValidUntil: "2026-11-30" }), source({ sourceIssuedOn: "2026-10-14" }), "2026-10-14");
  const future = await resolve(context, renewed, "2026-11-01");
  assert.deepEqual(future.lastPriceChangeAt, original.priceUpdatedOn);
  assert.deepEqual(future.lastPriceConfirmedAt, { seconds: Date.parse("2026-10-14T12:00:00Z") / 1000 });
  assert.equal(count(context, "supplierPriceVersions"), 2, "renewed validity is a distinct immutable agreement even when price is unchanged");
});

test("partial or corrupt restored agreement evidence cannot silently supply a trusted price", async () => {
  const context = database();
  await approve(context, null, offer(), source());
  const [path, version] = [...context.db.records].find(([key]) => key.includes("/supplierPriceVersions/"));
  context.db.records.delete(path);
  await assert.rejects(loadSupplierPriceVersions(context.tx, context.db, "hotel", "product"), /confirmation evidence needs review/);
  context.db.records.set(path, { ...version, terms: { ...version.terms, currency: "USD" } });
  await assert.rejects(loadSupplierPriceVersions(context.tx, context.db, "hotel", "product"), /Approved supplier price evidence needs review/);
  context.db.records.set(path, version);
  context.db.records.set(path + "-duplicate", version);
  await assert.rejects(loadSupplierPriceVersions(context.tx, context.db, "hotel", "product"), /Approved supplier price evidence needs review/);
});

test("future price activation retains the current stable catalog link, SKU, local label and barcode metadata", async () => {
  const context = database();
  const unlinked = await approve(context, null, offer({ catalogProductId: null }), undefined, "2026-10-14");
  const scheduled = await approve(context, unlinked, offer({ catalogProductId: null, pricePerPurchaseUnit: 20, priceValidFrom: "2026-11-01" }), source(), "2026-10-14");
  const local = await approve(context, scheduled, offer({ catalogProductId: "juice", supplierSku: "LOCAL-SKU", supplierProductName: "Reviewed local name", gtin: "6291041500213" }), undefined, "2026-10-20");
  const future = await resolve(context, local, "2026-11-01");
  assert.equal(future.product.pricePerPurchaseUnit, 20);
  assert.equal(future.product.catalogProductId, "juice"); assert.equal(future.product.supplierSku, "LOCAL-SKU");
  assert.equal(future.product.supplierProductName, "Reviewed local name"); assert.equal(future.product.gtin, "6291041500213");
  const versions = await loadSupplierPriceVersions(context.tx, context.db, "hotel", "product");
  const amended = versions.map((version) => ({ ...version, productTerms: { ...version.productTerms,
    catalogProductId: "stale-link", supplierSku: "STALE-SKU", supplierProductName: "Stale name", gtin: "036000291452" } }));
  const defensive = resolveSupplierPriceVersion(local, amended, { orderDate: "2026-11-01", pricingDateBasis: "order-date" });
  assert.equal(defensive.product.catalogProductId, "juice"); assert.equal(defensive.product.supplierSku, "LOCAL-SKU");
  assert.equal(defensive.product.supplierProductName, "Reviewed local name"); assert.equal(defensive.product.gtin, "6291041500213");
});

test("the bounded latest-approved purchase preview permits future choices without relabelling them as today's terms", async () => {
  const context = database();
  const current = await approve(context, null, offer(), undefined, "2026-10-14");
  const pending = await approve(context, current, offer({ supplierProductName: "Reviewed local label", pricePerPurchaseUnit: 20, priceValidFrom: "2026-11-01",
    purchaseOptions: [{ id: "new-bottle", purchaseUnit: "Bottle", baseUnitsPerPurchaseUnit: 1, pricePerPurchaseUnit: 3, gtin: "6291041500213" }] }), source(), "2026-10-14");
  assert.equal(pending.pricePerPurchaseUnit, 12);
  assert.deepEqual(pending.purchaseOptions, []);
  assert.equal(pending.latestApprovedPurchaseTerms.pricePerPurchaseUnit, 20);
  assert.equal(pending.latestApprovedPurchaseTerms.priceValidFrom, "2026-11-01");
  assert.equal(pending.latestApprovedPurchaseTerms.purchaseOptions[0].id, "new-bottle");
  assert.equal(pending.latestApprovedPurchaseTerms.versionId, pending.latestApprovedPriceVersionId);
  for (const excluded of ["supplierProductName", "catalogProductId", "supplierSku", "sourceReference", "approvedBy", "gtin"]) assert.equal(Object.hasOwn(pending.latestApprovedPurchaseTerms, excluded), false);
  assert.equal(Object.hasOwn(pending.latestApprovedPurchaseTerms.purchaseOptions[0], "gtin"), false);
});

test("repeat confirmation of a future-only offer does not expose its price as the current projection", async () => {
  const context = database();
  const terms = offer({ priceValidFrom: "2026-11-01" });
  const pending = await approve(context, null, terms, source(), "2026-10-14");
  const repeated = await approve(context, pending, terms, source({ sourceIssuedOn: "2026-10-15" }), "2026-10-15");
  assert.equal(repeated.pricePerPurchaseUnit, null); assert.equal(count(context, "supplierPriceVersions"), 1);
  assert.equal(repeated.latestApprovedPurchaseTerms.pricePerPurchaseUnit, 12);
  assert.equal((await resolve(context, repeated, "2026-10-15")).priceValidity, "future");
});

test("a later-approved backfilled period cannot displace an agreement with a later contractual start", async () => {
  const context = database();
  const january = await approve(context, null, offer({ pricePerPurchaseUnit: 30, priceValidFrom: "2027-01-01" }),
    source({ sourceIssuedOn: "2026-10-01" }), "2026-10-14");
  const backfilled = await approve(context, january, offer({ pricePerPurchaseUnit: 26, priceValidFrom: "2026-11-01" }),
    source({ sourceIssuedOn: "2027-02-01", sourceReference: "Backfilled November terms.xlsx" }), "2027-02-01");
  const current = await resolve(context, backfilled, "2027-02-10");
  assert.equal(current.product.pricePerPurchaseUnit, 30);
  assert.equal(current.product.priceValidFrom, "2027-01-01");
  assert.equal(backfilled.pricePerPurchaseUnit, 30, "the retained projection also keeps the applicable January agreement");
});

test("newer retained projections cannot supply prices before the first approved period or after partial evidence restoration", async () => {
  const context = database();
  const product = await approve(context, null, offer({ pricePerPurchaseUnit: 30, priceValidFrom: "2027-01-01" }), source(), "2027-01-14");
  const before = await resolve(context, product, "2026-12-31");
  assert.equal(before.priceValidity, "future"); assert.equal(before.versionId, null); assert.equal(before.product.pricePerPurchaseUnit, null);
  const versions = await loadSupplierPriceVersions(context.tx, context.db, "hotel", "product");
  assert.throws(() => resolveSupplierPriceVersion(product, [], { orderDate: "2027-01-20", pricingDateBasis: "order-date" }), /evidence needs reconciliation/);
  assert.equal(resolveSupplierPriceVersion(product, versions, { orderDate: "2027-01-20", pricingDateBasis: "order-date" }).product.pricePerPurchaseUnit, 30);
});
