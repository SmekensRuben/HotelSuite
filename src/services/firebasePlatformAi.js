import { auth, functions, httpsCallable } from "../firebaseConfig";

const accessError = () => Object.assign(new Error("Your current platform access could not be verified. Sign in again."), { code: "functions/permission-denied" });
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const amount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\\/\u0000-\u001f]/.test(value);
const invalid = (subject) => { throw new Error(`The AI ${subject} response could not be verified. Refresh this view.`); };

async function verifyActor(actor) {
  if (!actor?.uid || actor.emailVerified !== true || auth.currentUser !== actor) throw accessError();
  const token = await actor.getIdTokenResult(true);
  if (auth.currentUser !== actor || token?.claims?.platformAdmin !== true || actor.emailVerified !== true) throw accessError();
}

async function call(name, input = {}) {
  const actor = auth.currentUser;
  await verifyActor(actor);
  const response = await httpsCallable(functions, name)(input);
  // A refreshed token and the actual Firebase User object fence a late response,
  // including reauthentication with the same UID or a revoked operator claim.
  await verifyActor(actor);
  return response?.data;
}

function settingsResponse(data) {
  const configuration = data?.configuration;
  if (!plain(data) || typeof data.configured !== "boolean" || !integer(data.revision)
    || !plain(configuration) || configuration.revision !== data.revision || configuration.policyVersion !== 1
    || typeof configuration.enabled !== "boolean" || configuration.model !== "gpt-6-luna"
    || !["none", "low"].includes(configuration.reasoningEffort)
    || configuration.fallbackEnabled !== false || configuration.fallbackModel !== null
    || data.secretName !== "OPENAI_API_KEY" || data.secretVerification !== "not_verified"
    || !plain(data.capabilities) || data.capabilities.fallback !== false
    || JSON.stringify(data.capabilities.models) !== JSON.stringify(["gpt-6-luna"])
    || JSON.stringify(data.capabilities.reasoningEfforts) !== JSON.stringify(["none", "low"])) invalid("settings");
  for (const [key, minimum, maximum] of [["maxInputTokens", 1000, 200000], ["maxOutputTokens", 512, 32000],
    ["maxConcurrentJobsPerHotel", 1, 2], ["maxImportsPerHotelPerDay", 1, 100], ["maxCallsPerImport", 1, 32]]) {
    if (!integer(configuration[key]) || configuration[key] < minimum || configuration[key] > maximum) invalid("settings");
  }
  for (const [key, maximum] of [["maxCostPerImportUsd", 0.25], ["maxMonthlyCostPerHotelUsd", 100]]) {
    if (!amount(configuration[key]) || configuration[key] <= 0 || configuration[key] > maximum) invalid("settings");
  }
  if (configuration.maxMonthlyCostPerHotelUsd < configuration.maxCostPerImportUsd) invalid("settings");
  return data;
}

export async function getPlatformSupplierAiImportSettings() {
  return settingsResponse(await call("getPlatformSupplierAiImportSettings"));
}

export async function savePlatformSupplierAiImportSettings(input) {
  if (!plain(input) || !plain(input.configuration) || !integer(input.expectedRevision) || !id(input.requestId)) {
    throw new Error("Refresh the AI settings before saving.");
  }
  settingsResponse({ configured: true, revision: input.expectedRevision, configuration: input.configuration,
    secretName: "OPENAI_API_KEY", secretVerification: "not_verified",
    capabilities: { models: ["gpt-6-luna"], reasoningEfforts: ["none", "low"], fallback: false } });
  const data = settingsResponse(await call("savePlatformSupplierAiImportSettings", input));
  if (data.revision !== input.expectedRevision + 1 && !(data.replayed === true
    && data.appliedRevision === input.expectedRevision + 1 && data.revision >= data.appliedRevision)) invalid("settings acknowledgement");
  return data;
}

function usageResponse(data, month, pageSize, cursor) {
  if (!plain(data) || data.month !== month || !Array.isArray(data.hotels) || data.hotels.length > pageSize
    || !(data.nextCursor === null || id(data.nextCursor)) || data.nextCursor !== null && (data.nextCursor === cursor || !data.hotels.length)) invalid("usage");
  const seen = new Set();
  for (const hotel of data.hotels) {
    if (!plain(hotel) || !id(hotel.id) || seen.has(hotel.id) || typeof hotel.name !== "string" || !plain(hotel.usage)
      || !["none", "available", "unavailable"].includes(hotel.usage.state)) invalid("usage");
    seen.add(hotel.id);
    if (hotel.usage.state === "unavailable") continue;
    for (const key of ["importsStarted", "attemptedCalls", "succeededCalls", "unknownCalls", "countingCalls", "inputTokens", "outputTokens"]) {
      if (!integer(hotel.usage[key])) invalid("usage");
    }
    if (hotel.usage.succeededCalls + hotel.usage.unknownCalls > hotel.usage.attemptedCalls) invalid("usage");
    if (!amount(hotel.usage.knownCostUsd) || !amount(hotel.usage.reservedCostUsd)
      || (hotel.usage.unknownCalls > 0 || hotel.usage.reservedCostUsd > 0) && hotel.usage.actualCostUsd !== null
      || hotel.usage.unknownCalls === 0 && hotel.usage.reservedCostUsd === 0
        && (!amount(hotel.usage.actualCostUsd) || hotel.usage.actualCostUsd !== hotel.usage.knownCostUsd)) invalid("usage");
    if (hotel.usage.state === "none" && Object.entries(hotel.usage).some(([key, value]) => key !== "state" && typeof value === "number" && value !== 0)) invalid("usage");
  }
  return data;
}

export async function listPlatformSupplierAiUsage({ month, cursor = null, pageSize = 25 }) {
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
    || !(cursor === null || id(cursor)) || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new Error("Choose a valid usage month and page.");
  }
  return usageResponse(await call("listPlatformSupplierAiUsage", { month, cursor, pageSize }), month, pageSize, cursor);
}
