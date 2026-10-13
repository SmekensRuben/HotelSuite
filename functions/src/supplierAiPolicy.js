const { HttpsError } = require("firebase-functions/v2/https");

const AI_POLICY_VERSION = 1;
const AI_CONFIGURATION_PATH = "platformConfiguration/aiSupplierProductImport";
const PRICE_VERSION = "openai-standard-short-context-cache-write-bound-2026-10-13-v1";
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const SOURCE_RETENTION_MS = 7 * 86400000;
const DEFAULT_AI_CONFIGURATION = Object.freeze({ enabled: false, model: "gpt-6-luna", reasoningEffort: "low",
  fallbackEnabled: false, fallbackModel: null, maxCostPerImportUsd: 0.25, maxMonthlyCostPerHotelUsd: 10,
  maxInputTokens: 200000, maxOutputTokens: 32000, maxConcurrentJobsPerHotel: 2, maxImportsPerHotelPerDay: 20,
  maxCallsPerImport: 32,
  revision: 0, policyVersion: AI_POLICY_VERSION });
const CONFIG_FIELDS = new Set(Object.keys(DEFAULT_AI_CONFIGURATION));
function fail(message) { throw new HttpsError("failed-precondition", message); }
function normalizeSupplierAiConfiguration(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !CONFIG_FIELDS.has(key)
    && !["updatedAt", "updatedBy"].includes(key))) fail("The supplier AI configuration contains unsupported fields.");
  const result = { ...DEFAULT_AI_CONFIGURATION, ...value };
  delete result.updatedAt; delete result.updatedBy;
  if (typeof result.enabled !== "boolean" || result.model !== "gpt-6-luna" || !["none", "low"].includes(result.reasoningEffort)) fail("Choose the supported supplier-import model and reasoning effort.");
  if (result.fallbackEnabled !== false || result.fallbackModel !== null) fail("Automatic fallback is not supported. Supplier imports never switch to a more expensive model.");
  if (result.policyVersion !== AI_POLICY_VERSION || !Number.isSafeInteger(result.revision) || result.revision < 0) fail("The supplier AI configuration version is invalid.");
  for (const [field, minimum, maximum] of [["maxInputTokens", 1000, 200000], ["maxOutputTokens", 512, 32000],
    ["maxConcurrentJobsPerHotel", 1, 2], ["maxImportsPerHotelPerDay", 1, 100], ["maxCallsPerImport", 1, 32]]) {
    if (!Number.isSafeInteger(result[field]) || result[field] < minimum || result[field] > maximum) fail(`${field} is outside its supported limits.`);
  }
  for (const [field, maximum] of [["maxCostPerImportUsd", 0.25], ["maxMonthlyCostPerHotelUsd", 100]]) {
    if (typeof result[field] !== "number" || !Number.isFinite(result[field]) || result[field] <= 0 || result[field] > maximum
      || !Number.isSafeInteger(result[field] * 1000000)) fail(`${field} must be a positive amount within the supported limit.`);
  }
  if (result.maxMonthlyCostPerHotelUsd < result.maxCostPerImportUsd) fail("The monthly hotel budget must cover one import.");
  return result;
}
async function loadSupplierAiConfiguration(db, transaction) {
  const ref = db.doc(AI_CONFIGURATION_PATH);
  const snapshot = transaction ? await transaction.get(ref) : await ref.get();
  return normalizeSupplierAiConfiguration(snapshot.exists ? snapshot.data() : {});
}
function inputReservationTokens(inputTokens) {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 1 || inputTokens > 200000) fail("The complete source exceeds the supported AI input token limit.");
  // Count the exact request remotely, then reserve a margin for provider accounting differences.
  return inputTokens + Math.ceil(inputTokens * 0.02) + 256;
}
function costMicros(inputTokens, outputTokens) {
  if (![inputTokens, outputTokens].every((v) => Number.isSafeInteger(v) && v >= 0)) fail("Verified token usage is required to estimate AI cost.");
  // USD 0.125 / million input tokens covers the 1.25x cache-write premium;
  // USD 0.50 / million output tokens. This is a conservative estimate, not an invoice.
  // Reasoning tokens are already included in output_tokens; do not add them twice.
  return Math.ceil((inputTokens + 4 * outputTokens) / 8);
}
function normalizedProviderUsage(response) {
  const usage = response?.usage;
  if (!usage || ![usage.input_tokens, usage.output_tokens].every((v) => Number.isSafeInteger(v) && v >= 0)
    || usage.input_tokens < 1 || !Number.isSafeInteger(usage.total_tokens) || usage.total_tokens !== usage.input_tokens + usage.output_tokens
    || usage.output_tokens_details?.reasoning_tokens != null && (!Number.isSafeInteger(usage.output_tokens_details.reasoning_tokens)
      || usage.output_tokens_details.reasoning_tokens < 0 || usage.output_tokens_details.reasoning_tokens > usage.output_tokens)) return null;
  if (typeof response.model !== "string" || !(response.model === "gpt-6-luna" || /^gpt-6-luna-\d{4}-\d\d-\d\d$/.test(response.model))) return null;
  return { model: response.model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null, costMicros: costMicros(usage.input_tokens, usage.output_tokens),
    priceVersion: PRICE_VERSION, costKind: "conservative-standard-including-cache-write-premium" };
}
function boundedResponseText(response) {
  if (response?.status !== "completed") fail(response?.status === "incomplete" ? "The AI output was truncated. Import a smaller file; no partial result was accepted." : "The AI response did not complete.");
  const parts = (response.output || []).flatMap((item) => item.type === "message" ? item.content || [] : []);
  if (parts.some((part) => part.type === "refusal") || parts.some((part) => part.type !== "output_text")) fail("The AI could not propose a complete supplier import.");
  const text = parts.map((part) => part.text).join("");
  if (!text || Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) fail("The AI returned an empty or oversized proposal.");
  try { return JSON.parse(text); } catch { fail("The AI proposal is not valid structured data."); }
}
module.exports = { AI_POLICY_VERSION, AI_CONFIGURATION_PATH, PRICE_VERSION, MAX_SOURCE_BYTES, SOURCE_RETENTION_MS,
  DEFAULT_AI_CONFIGURATION, normalizeSupplierAiConfiguration, loadSupplierAiConfiguration, inputReservationTokens, costMicros,
  normalizedProviderUsage, boundedResponseText };
