const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requirePlatformAdministrator, requireDocumentId } = require("./subscriptions");
const { revision, digest } = require("./validation");
const { writePlatformAudit } = require("./platformAudit");
const { AI_CONFIGURATION_PATH, AI_POLICY_VERSION, normalizeSupplierAiConfiguration } = require("./supplierAiPolicy");

const COUNTERS = ["importsStarted", "attemptedCalls", "succeededCalls", "unknownCalls", "countingCalls", "inputTokens", "outputTokens"];
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
function settingsView(snapshot) {
  const configuration = normalizeSupplierAiConfiguration(snapshot.exists ? snapshot.data() : {});
  return { configured: snapshot.exists, revision: configuration.revision, configuration,
    secretName: "OPENAI_API_KEY", secretVerification: "not_verified",
    capabilities: { models: ["gpt-6-luna"], reasoningEfforts: ["none", "low"], fallback: false } };
}
async function getPlatformSupplierAiImportSettingsHandler(request, services = {}) {
  await requirePlatformAdministrator({ ...request }, services.auth);
  const db = services.firestore || admin.firestore();
  const snapshot = await db.doc(AI_CONFIGURATION_PATH).get();
  await requirePlatformAdministrator({ ...request }, services.auth);
  return settingsView(snapshot);
}
async function savePlatformSupplierAiImportSettingsHandler(request, services = {}) {
  await requirePlatformAdministrator({ ...request }, services.auth);
  const input = request.data || {};
  if (Object.keys(input).some((key) => !["configuration", "expectedRevision", "requestId"].includes(key))) throw new HttpsError("invalid-argument", "Unsupported AI settings field.");
  const expected = revision(input.expectedRevision), requestId = requireDocumentId(input.requestId, "requestId");
  if (expected >= Number.MAX_SAFE_INTEGER) throw new HttpsError("failed-precondition", "The AI settings revision needs operator review.");
  const configuration = normalizeSupplierAiConfiguration(input.configuration);
  if (configuration.revision !== expected) throw new HttpsError("invalid-argument", "Refresh the AI settings revision before saving.");
  const fingerprint = digest(configuration, expected), db = services.firestore || admin.firestore();
  const ref = db.doc(AI_CONFIGURATION_PATH), operation = db.doc(`platformAiConfigurationOperations/${digest(request.auth.uid, requestId)}`);
  return db.runTransaction(async (tx) => {
    const [current, receipt] = await Promise.all([tx.get(ref), tx.get(operation)]);
    await requirePlatformAdministrator({ ...request }, services.auth);
    const previous = settingsView(current);
    if (receipt.exists) {
      if (receipt.data().fingerprint !== fingerprint || receipt.data().actorUid !== request.auth.uid) throw new HttpsError("already-exists", "This settings request was already used with different values.");
      if (receipt.data().revision !== expected + 1 || previous.revision < receipt.data().revision) throw new HttpsError("failed-precondition", "AI settings command evidence needs operator review.");
      return { ...previous, replayed: true, appliedRevision: receipt.data().revision };
    }
    if (previous.revision !== expected) throw new HttpsError("aborted", "AI settings changed. Reload before saving.");
    const next = { ...configuration, revision: expected + 1, updatedAt: stamp(), updatedBy: request.auth.uid };
    tx.set(ref, next);
    tx.create(operation, { actorUid: request.auth.uid, fingerprint, revision: next.revision, createdAt: stamp() });
    writePlatformAudit(tx, db, { key: operation.id, hotelUid: null, actorUid: request.auth.uid,
      action: "supplier-ai-settings-updated", targetId: "aiSupplierProductImport", revision: next.revision });
    return settingsView({ exists: true, data: () => next });
  });
}
function usageView(snapshot, month) {
  if (!snapshot.exists) return { state: "none", ...Object.fromEntries(COUNTERS.map((key) => [key, 0])), knownCostUsd: 0, reservedCostUsd: 0, actualCostUsd: 0 };
  const data = snapshot.data();
  const required = [...COUNTERS, "knownCostMicros", "reservedCostMicros"];
  if (!data || data.month !== month || data.policyVersion !== AI_POLICY_VERSION
    || required.some((key) => !Number.isSafeInteger(data[key]) || data[key] < 0)
    || data.succeededCalls + data.unknownCalls > data.attemptedCalls) return { state: "unavailable", reason: "Usage accounting needs operator review." };
  const optional = { reviewReadyJobs: "importsReviewReady", failedJobs: "importsFailed", committedJobs: "importsCommitted" };
  if (Object.values(optional).some((key) => data[key] !== undefined && (!Number.isSafeInteger(data[key]) || data[key] < 0))) return { state: "unavailable", reason: "Usage accounting needs operator review." };
  return { state: "available", ...Object.fromEntries(COUNTERS.map((key) => [key, data[key]])),
    ...Object.fromEntries(Object.entries(optional).filter(([, key]) => data[key] !== undefined).map(([name, key]) => [name, data[key]])),
    knownCostUsd: data.knownCostMicros / 1000000, reservedCostUsd: data.reservedCostMicros / 1000000,
    actualCostUsd: data.unknownCalls > 0 || data.reservedCostMicros > 0 ? null : data.knownCostMicros / 1000000 };
}
async function listPlatformSupplierAiUsageHandler(request, services = {}) {
  await requirePlatformAdministrator({ ...request }, services.auth);
  const { month, cursor = null, pageSize = 25 } = request.data || {};
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpsError("invalid-argument", "Choose a valid UTC usage month.");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new HttpsError("invalid-argument", "Usage page size must be between 1 and 50.");
  const after = cursor == null ? null : requireDocumentId(cursor, "cursor"), db = services.firestore || admin.firestore();
  let query = db.collection("hotels").orderBy(admin.firestore.FieldPath.documentId());
  if (after !== null) query = query.startAfter(after);
  const result = await query.limit(pageSize + 1).get(), page = result.docs.slice(0, pageSize);
  const usage = page.length ? await db.getAll(...page.map((hotel) => db.doc(`hotels/${hotel.id}/aiUsageMonths/${month}`))) : [];
  await requirePlatformAdministrator({ ...request }, services.auth);
  return { month, hotels: page.map((hotel, index) => ({ id: hotel.id,
    name: String(hotel.data().hotelName || hotel.data().name || hotel.id).slice(0, 200), usage: usageView(usage[index], month) })),
    nextCursor: result.docs.length > pageSize ? page.at(-1).id : null };
}
const options = { region: "us-central1", cors: true };
module.exports = { settingsView, usageView, getPlatformSupplierAiImportSettingsHandler, savePlatformSupplierAiImportSettingsHandler, listPlatformSupplierAiUsageHandler,
  getPlatformSupplierAiImportSettings: onCall(options, getPlatformSupplierAiImportSettingsHandler),
  savePlatformSupplierAiImportSettings: onCall(options, savePlatformSupplierAiImportSettingsHandler),
  listPlatformSupplierAiUsage: onCall(options, listPlatformSupplierAiUsageHandler) };
