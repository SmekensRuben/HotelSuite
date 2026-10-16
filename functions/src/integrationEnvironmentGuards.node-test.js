process.env.DEPLOYMENT_ENV = "staging";
process.env.GCLOUD_PROJECT = "hotel-toolkit-staging";
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: "hotel-toolkit-staging", storageBucket: "hotel-toolkit-staging.appspot.com" });
for (const key of ["GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "FUNCTIONS_EMULATOR", "FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "STORAGE_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) delete process.env[key];

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSupplierAiProvider } = require("./supplierAiProvider");
const { researchGuests, processGuestIntelligenceForHotel, processNightlyGuestIntelligenceHandler } = require("./guestIntelligence");
const { downloadProposalImage } = require("./hotelMcpImageDownload");
const { fetchResendAttachmentBuffer, meiliRequest, getIndexUid, requireMeiliHost } = require("./common");
const { verifyResendWebhook, createResendEmailReceivedHandler, handleResendEmailReceivedWebhook } = require("./webhook");
const { syncCatalogProductsToMeili, syncSupplierProductsToMeili } = require("./meili");
const { admin, RESEND_API_KEY, RESEND_WEBHOOK_SECRET, MEILI_HOST, MEILI_INDEX, MEILI_API_KEY } = require("./config");

const disabled = (error) => error.code === "failed-precondition";
function inaccessibleResource() {
  return new Proxy({}, { get() { assert.fail("A disabled integration accessed a resource."); } });
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test("staging rejects provider calls and image downloads before any network access", async (t) => {
  const network = t.mock.fn(() => assert.fail("A disabled integration contacted a provider."));
  assert.throws(() => createSupplierAiProvider({ apiKey: "fictional-key", fetchImpl: network }), disabled);
  await assert.rejects(researchGuests("fictional-key", "gpt-4.1-mini", [], network), disabled);
  await assert.rejects(downloadProposalImage("https://images.example.test/photo.png", { lookup: network, request: network }), disabled);
  assert.equal(network.mock.callCount(), 0);
});

test("a supplier provider created under production policy rechecks policy before each request", async (t) => {
  const original = { DEPLOYMENT_ENV: process.env.DEPLOYMENT_ENV, GCLOUD_PROJECT: process.env.GCLOUD_PROJECT, FIREBASE_CONFIG: process.env.FIREBASE_CONFIG };
  const network = t.mock.fn(() => assert.fail("A disabled supplier provider made an HTTP request."));
  let provider;
  try {
    process.env.DEPLOYMENT_ENV = "production";
    process.env.GCLOUD_PROJECT = "hotel-toolkit";
    process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: "hotel-toolkit" });
    provider = createSupplierAiProvider({ apiKey: "fictional-key", fetchImpl: network });
  } finally { Object.assign(process.env, original); }
  await assert.rejects(provider.respond({}), disabled);
  await assert.rejects(provider.countInput({}), disabled);
  assert.equal(network.mock.callCount(), 0);
});

test("staging blocks guest research before reading guest data or the stored API key", async () => {
  const db = inaccessibleResource();
  await assert.rejects(processGuestIntelligenceForHotel("fictional-hotel", { db }), disabled);
  await assert.rejects(processNightlyGuestIntelligenceHandler({ db }), disabled);
});

test("staging rejects search and attachment helpers before reading provider secrets", async (t) => {
  for (const secret of [RESEND_API_KEY, RESEND_WEBHOOK_SECRET, MEILI_HOST, MEILI_INDEX, MEILI_API_KEY]) {
    t.mock.method(secret, "value", () => assert.fail("A disabled integration read a provider secret."));
  }
  t.mock.method(global, "fetch", () => assert.fail("A disabled integration made an HTTP request."));
  await assert.rejects(fetchResendAttachmentBuffer({ email_id: "email-a" }, "attachment-a"), disabled);
  await assert.rejects(meiliRequest("/indexes"), disabled);
  assert.throws(() => getIndexUid(), disabled);
  assert.throws(() => requireMeiliHost(), disabled);
  assert.throws(() => verifyResendWebhook({}), disabled);
});

test("staging webhook returns 403 before verification, routing or storage access", async (t) => {
  const verify = t.mock.fn(() => assert.fail("A disabled inbound integration verified a request."));
  const handler = createResendEmailReceivedHandler({ db: inaccessibleResource(), bucket: inaccessibleResource(), verify });
  const res = response();
  await handler({ method: "POST" }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "Inbound integrations are disabled in this environment." });
  assert.equal(verify.mock.callCount(), 0);
  t.mock.method(admin, "firestore", () => assert.fail("A disabled webhook initialized Firestore."));
  t.mock.method(admin, "storage", () => assert.fail("A disabled webhook initialized Storage."));
  const deployedResponse = response();
  await handleResendEmailReceivedWebhook({ method: "POST", headers: {} }, deployedResponse);
  assert.equal(deployedResponse.statusCode, 403);
  assert.deepEqual(deployedResponse.body, res.body);
});

test("staging search triggers return without reading event data or search secrets", async (t) => {
  for (const secret of [MEILI_HOST, MEILI_INDEX, MEILI_API_KEY]) {
    t.mock.method(secret, "value", () => assert.fail("A disabled search trigger read a provider secret."));
  }
  t.mock.method(global, "fetch", () => assert.fail("A disabled search trigger contacted the provider."));
  await syncCatalogProductsToMeili.run(inaccessibleResource());
  await syncSupplierProductsToMeili.run(inaccessibleResource());
});
