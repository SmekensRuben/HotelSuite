const { onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { createHash, randomUUID } = require("node:crypto");
const { admin, logger, OPENAI_API_KEY } = require("./config");
const { requireHotelPermission } = require("./authorization");
const { requireSaasRollout } = require("./saasRollout");
const { requireDocumentId } = require("./subscriptions");
const { digest } = require("./validation");
const { decimal } = require("./productPolicy");
const { AI_POLICY_VERSION, PRICE_VERSION, MAX_SOURCE_BYTES, SOURCE_RETENTION_MS, loadSupplierAiConfiguration,
  inputReservationTokens, costMicros, normalizedProviderUsage, boundedResponseText } = require("./supplierAiPolicy");
const { createSupplierAiRequest, createSupplierAiProvider } = require("./supplierAiProvider");
const { mappingScope, mappingProfileRef, mappingSnapshot } = require("./supplierImportMappings");
const prefix = "private/supplier-ai-imports", LEASE_MS = 600000;
const IMPORT_POLICY_VERSION = 2;
const REVIEW_WORKSPACE_VERSION = 1;
const IMPORT_SETTING_FIELDS = ["policyVersion", "priceBasis", "currency", "vatRate"];
const OPTIONAL_SETTING_FIELDS = ["assortmentMode", "documentPurpose", "sourceIssuedOn", "priceValidFrom", "priceValidUntil"];
const currencyCodes = new Set(Intl.supportedValuesOf("currency"));
const HTTP_STATUS = { unauthenticated: 401, "permission-denied": 403, "not-found": 404, "invalid-argument": 400,
  "failed-precondition": 409, "resource-exhausted": 429, "already-exists": 409, aborted: 409, unavailable: 503 };
const TERMINAL = new Set(["review", "failed", "response_unknown", "committed", "completed"]);
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const hashOf = (bytes) => createHash("sha256").update(bytes).digest("hex");
const billingMonthOf = (services) => new Date(services.now?.() ?? Date.now()).toISOString().slice(0, 7);
function strictId(value, field) {
  const id = requireDocumentId(value, field);
  if (/[\\\u0000-\u001f]/.test(id)) throw new HttpsError("invalid-argument", `${field} contains unsupported characters.`);
  return id;
}
function validGeneration(value) {
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) throw new HttpsError("failed-precondition", "The import source generation is unavailable.");
  return value;
}
function validateImportSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || IMPORT_SETTING_FIELDS.some((field) => !Object.hasOwn(value, field))
    || Object.keys(value).some((field) => ![...IMPORT_SETTING_FIELDS, ...OPTIONAL_SETTING_FIELDS].includes(field))) throw new HttpsError("invalid-argument", "Choose the import price basis, currency and optional VAT rate before uploading.");
  if (value.policyVersion !== IMPORT_POLICY_VERSION) throw new HttpsError("invalid-argument", "Refresh the import form before uploading.");
  if (!["net", "gross", "unknown"].includes(value.priceBasis)) throw new HttpsError("invalid-argument", "Choose net, gross or explicitly unknown source pricing.");
  if (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency) || !currencyCodes.has(value.currency)) throw new HttpsError("invalid-argument", "Choose a supported ISO currency for this import.");
  if (value.vatRate !== null && (typeof value.vatRate !== "number" || !Number.isFinite(value.vatRate) || value.vatRate < 0 || value.vatRate > 1)) throw new HttpsError("invalid-argument", "Choose an explicit VAT fraction between zero and one, or leave VAT unknown.");
  let vatRate = null;
  try { if (value.vatRate !== null) vatRate = decimal(value.vatRate, "VAT rate", { maximum: 1 }); }
  catch { throw new HttpsError("invalid-argument", "Choose a VAT fraction with at most six decimal places, or leave VAT unknown."); }
  const optional = {};
  for (const field of OPTIONAL_SETTING_FIELDS) if (Object.hasOwn(value, field)) {
    const setting = value[field];
    if (field === "assortmentMode" ? !["full", "partial", "unknown"].includes(setting)
      : field === "documentPurpose" ? !["price-list", "product-list", "statistics"].includes(setting)
        : setting !== null && require("./supplierImportFormat").dateCell(setting, "YYYY-MM-DD") !== setting)
      throw new HttpsError("invalid-argument", "Choose a supported source purpose, assortment scope and explicit ISO business dates.");
    optional[field] = setting;
  }
  if (optional.priceValidFrom && optional.priceValidUntil && optional.priceValidUntil < optional.priceValidFrom) throw new HttpsError("invalid-argument", "Price validity must end on or after its start date.");
  return { policyVersion: IMPORT_POLICY_VERSION, priceBasis: value.priceBasis, currency: value.currency, vatRate, ...optional };
}
function parseImportSettings(value) {
  if (typeof value !== "string" || value.length > 1024 || !value.trim()) throw new HttpsError("invalid-argument", "Choose the import price basis, currency and optional VAT rate before uploading.");
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new HttpsError("invalid-argument", "The import settings could not be read. Refresh the import form."); }
  return validateImportSettings(parsed);
}
function settingsForJob(job) {
  if (job.importPolicyVersion === undefined || job.importPolicyVersion === 1) {
    if (job.importSettings !== undefined) throw new HttpsError("failed-precondition", "This import has inconsistent saved business settings. Start a new import.");
    return undefined;
  }
  if (job.importPolicyVersion !== IMPORT_POLICY_VERSION) throw new HttpsError("failed-precondition", "This import uses an unsupported business policy. Start a new import.");
  return validateImportSettings(job.importSettings);
}
function publicImportSettings(job) {
  try { return settingsForJob(job) || null; } catch { return null; }
}
const SUMMARY_COUNT_FIELDS = ["normalizedRows", "assumptionRows", "unknownPriceRows", "blockedNormalizationRows", "inferredPieceRows", "missingRequiredRows"];
const SUMMARY_BUSINESS_FIELDS = new Set(["supplierSku", "supplierProductName", "currency", "pricingModel", "purchaseUnit", "baseUnit", "priceBasis", "gtin", "priceValidFrom", "priceValidUntil",
  "pricePerBaseUnit", "pricePerPurchaseUnit", "baseUnitsPerPurchaseUnit", "vatRate", "price", "contract", "active", "supplierId", "catalogProductId", "sourceAnchors", "packInference", "purchaseOptions", "sourceInterpretation", "sourceIssuedOn"]);
const SUMMARY_BUSINESS_MESSAGES = Object.freeze({
  "source-format-review-required": "Confirm this supplier file's columns, package content and price channel before importing products.",
  "source-format-cell-invalid": "A source cell does not match the confirmed format. Review the source interpretation before approving it.",
  "source-format-context-conflict": "The confirmed source terms differ from this import's pricing context. Review them before approval.",
  "source-formula-unverified": "A cached spreadsheet formula needs an explicit supplier value before approval.",
  "approved-name-expansion": "An approved product abbreviation was expanded. Confirm the product identity.",
  "display-name-normalized": "Display words and SI labels were standardized; supplier SKU and GTIN were preserved.",
  "purchase-label-normalized": "The purchase-package label was standardized without creating another purchase option.",
  "purchase-unit-unconfirmed": "Confirm this source purchase unit and its English label before importing. Suggested abbreviations are not accepted supplier mappings.",
  "supplier-purchase-unit-mapped": "The confirmed supplier and source-format profile supplies the English purchase-package label. Quantities and financial terms remain unchanged.",
  "source-purchase-unit-recovered": "The verified purchase-package column supplies the package label; the physical content unit remains separate.",
  "split-package-content-unavailable": "Package count, inner content or content unit needs review. A weight purchase unit does not establish a mass-to-item conversion.",
  "kilogram-purchase-content": "One kg purchased contains exactly 1 kg or 1000 g. No piece weight or count is inferred.",
  "kilogram-purchase-measure": "Order quantities are kilograms; individual piece weight and count remain unknown.",
  "purchase-unit-confirmed-for-import": "The purchase-package label was explicitly confirmed for this import. Quantities and financial terms remain unchanged.",
  "base-unit-normalized": "The source unit was mapped to a supported physical unit without changing its dimension.",
  "unsupported-source-unit": "The source unit is unsupported or ambiguous. Choose a supported unit before confirmation.",
  "currency-normalized": "The explicit source currency was standardized to uppercase.",
  "currency-from-import-context": "Missing currency uses the selected import currency. Existing unpriced offers keep their prior financial terms.",
  "currency-context-conflict": "The source currency differs from the selected import currency. Review the contract before confirmation.",
  "price-basis-normalized": "The explicit source price basis was standardized.",
  "basis-from-import-context": "Missing source price basis uses the selected import context. Existing unpriced offers keep their prior financial terms.",
  "basis-context-conflict": "The source price basis differs from the selected import context. Review the contract before confirmation.",
  "vat-from-import-context": "Missing source VAT uses the selected VAT fraction. Confirm that this rate applies to the product.",
  "source-vat-retained": "Explicit source VAT takes precedence over the optional import VAT. Confirm that the document rate applies.",
  "statistical-amount-not-price": "A quantity, spend or statistical amount cannot establish a supplier unit price. The proposed price remains unknown.",
  "unit-price-unverified": "The proposed unit price cannot be established from a source price field. It remains unknown until reviewed.",
  "source-unit-price": "The unit price matches a source price field. Review its currency, tax and validity.",
  "visual-unit-price-unverified": "The visual source price needs review of its price channel, tax and validity.",
  "unsupported-pricing-model": "Choose a supported product pricing model before confirmation.",
  "pricing-model-from-channel": "The product pricing model follows the explicit source price channel.",
  "ambiguous-price-channel": "Both price channels were supplied without an authoritative basis. Choose the correct product pricing model.",
  "inactive-draft-price-model": "An unpriced new offer uses an inactive draft price contract; no purchase price was invented.",
  "source-price-missing": "The source has no established supplier unit price. New offers stay unpriced; existing prices are preserved.",
  "visual-package-content-unverified": "Check the full purchasable package content against the visual source.",
  "package-quantity-unverified": "The package quantity cannot be established from its source. Review its explicit content.",
  "single-pack-unit-inferred": "Named content supplies a single package's draft base unit. Verify the package.",
  "single-pack-content-inferred": "Named content supplies a single package's draft quantity. Verify the full purchasable package.",
  "package-dimension-conflict": "Named content and the proposed base unit have different dimensions. No physical conversion was guessed.",
  "package-content-missing": "The full purchasable package content is unknown. Supply an explicit quantity before confirmation.",
  "piece-count-inferred": "Named piece content divides the full package exactly. This review metadata does not change the inventory unit or purchase options.",
  "piece-count-not-integral": "Piece content does not divide the full package exactly. No rounded piece count was created.",
  "piece-count-unavailable": "The piece count cannot be represented exactly. The physical package remains unchanged.",
  "ambiguous-piece-content": "Several piece sizes could fit the package. No piece count was guessed.",
  missing: "A required product field must be supplied or corrected before import.",
  invalid: "A product field does not meet its contract. Review the row before confirmation.",
  unknown: "This commercial value is unknown. Review the row before it can be used for purchasing.",
  unlinked: "No catalog link was guessed. Choose a link for inventory conversion or keep the offer explicitly unlinked.",
  "existing-price-contract-preserved": "The source has no new unit price. Existing package and financial terms were preserved.",
  "duplicate-source-sku": "The import repeats a supplier SKU. Resolve source duplicates before confirmation.",
  "ambiguous-existing-sku": "Multiple existing products share this supplier and SKU. Resolve the identities before confirmation.",
  "protected-identity": "The existing product identity cannot be changed through AI import.",
  archived: "An archived supplier offer cannot be reactivated through this import.",
  "legacy-variants": "Legacy variants require reviewed purchase options before import.",
  "inactive-new-offer": "New imported offers start inactive. Enable them only after reviewing their purchase terms.",
  "missing-supplier": "The selected supplier no longer exists in this hotel.",
  "inactive-supplier": "An active offer requires an active supplier.",
  "missing-catalog": "The selected catalog product no longer exists in this hotel.",
  "inactive-catalog": "An active offer requires an active catalog product.",
  "catalog-conversion": "The supplier package and catalog inventory unit require a valid physical conversion.",
  "evidence-missing-anchors": "The product has no verifiable source reference. Exclude it or correct the source and import again.",
  "evidence-unknown-source": "The reference does not identify a supplied source row. Exclude it or correct the source and import again.",
  "evidence-quote-absent": "The reference quote cannot be verified. Exclude the row or correct the source and import again.",
  "evidence-context-only": "Header context alone cannot establish a product. Exclude the row or correct its source.",
});
function publicSummary(job) {
  if (job.importPolicyVersion !== IMPORT_POLICY_VERSION || !publicImportSettings(job)) return null;
  const summary = job.summary;
  if (!summary || summary.version !== IMPORT_POLICY_VERSION || !Number.isSafeInteger(summary.totalRows) || summary.totalRows < 0 || summary.totalRows > 1000
    || summary.totalRows !== job.totalRows || SUMMARY_COUNT_FIELDS.some((field) => !Number.isSafeInteger(summary[field]) || summary[field] < 0 || summary[field] > summary.totalRows)
    || !Array.isArray(summary.findings) || summary.findings.length > 20) return null;
  const findings = [];
  for (const finding of summary.findings) {
    if (!finding || typeof finding.field !== "string" || finding.field.length > 100 || typeof finding.code !== "string" || finding.code.length > 100
      || !["info", "warning", "error"].includes(finding.severity) || typeof finding.message !== "string" || finding.message.length > 1000
      || !Number.isSafeInteger(finding.count) || finding.count < 1 || finding.count > summary.totalRows || !Array.isArray(finding.rowIds) || finding.rowIds.length > 3
      || finding.rowIds.some((rowId) => typeof rowId !== "string" || !/^r-\d{6}$/.test(rowId))) return null;
    const recognized = SUMMARY_BUSINESS_FIELDS.has(finding.field) && Object.hasOwn(SUMMARY_BUSINESS_MESSAGES, finding.code);
    // Never echo arbitrary stored finding text. Operator billing accidentally
    // present in a corrupted summary must not enter a customer response.
    findings.push({ field: recognized ? finding.field : "review", code: recognized ? finding.code : "review-notice", severity: finding.severity,
      message: recognized ? SUMMARY_BUSINESS_MESSAGES[finding.code] : "Review this product finding before confirmation.", count: finding.count, rowIds: [...finding.rowIds] });
  }
  return { version: IMPORT_POLICY_VERSION, totalRows: summary.totalRows,
    ...Object.fromEntries(SUMMARY_COUNT_FIELDS.map((field) => [field, summary[field]])), findings };
}
function references(db, hotelUid, jobId, month, requestId) {
  return { job: db.doc(`hotels/${hotelUid}/supplierAiImportJobs/${jobId}`), month: db.doc(`hotels/${hotelUid}/aiUsageMonths/${month}`),
    state: db.doc(`hotels/${hotelUid}/aiImportAdministration/state`),
    ...(requestId ? { request: db.doc(`hotels/${hotelUid}/supplierAiImportRequests/${requestId}`) } : {}) };
}
function actorRequest(job) { return { auth: { uid: job.ownerUid, token: { email_verified: true, auth_time: job.authTime } } }; }
async function authorize(db, request, hotelUid, action, transaction, services = {}) {
  await requireSaasRollout(db, transaction);
  await requireHotelPermission(db, { auth: request.auth }, hotelUid, "supplierproducts", action, transaction, services.auth);
  if (action === "create") await requireHotelPermission(db, { auth: request.auth }, hotelUid, "supplierproducts", "read", transaction, services.auth);
}
function normalizeMonth(snapshot, month) {
  const data = snapshot.exists ? snapshot.data() : {};
  const result = { month, policyVersion: AI_POLICY_VERSION, importsStarted: 0, importsReviewReady: 0, importsFailed: 0,
    activeJobs: 0, attemptedCalls: 0, succeededCalls: 0, unknownCalls: 0, countingCalls: 0, knownCostMicros: 0,
    reservedCostMicros: 0, inputTokens: 0, outputTokens: 0, days: {}, ...data };
  if (snapshot.exists && Object.keys(result).some((key) => !["updatedAt", "importsCommitted"].includes(key) && data[key] === undefined)) throw new HttpsError("failed-precondition", "AI usage accounting is incomplete and needs operator review.");
  for (const [field, value] of Object.entries(result)) {
    if (["month", "policyVersion", "days", "updatedAt"].includes(field)) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new HttpsError("failed-precondition", "AI usage accounting needs operator review.");
  }
  if (result.month !== month || result.policyVersion !== AI_POLICY_VERSION || !result.days || typeof result.days !== "object" || Array.isArray(result.days)
    || Object.entries(result.days).some(([day, n]) => !/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isSafeInteger(n) || n < 0)) throw new HttpsError("failed-precondition", "AI usage accounting needs operator review.");
  return result;
}
function activeState(snapshot) {
  if (!snapshot.exists) return { activeJobs: 0, policyVersion: AI_POLICY_VERSION };
  if (!Number.isSafeInteger(snapshot.data().activeJobs) || snapshot.data().activeJobs < 0 || snapshot.data().policyVersion !== AI_POLICY_VERSION) throw new HttpsError("failed-precondition", "AI concurrent accounting needs operator review.");
  return snapshot.data();
}
const PUBLIC_ERROR_CODES = new Set([...Object.keys(HTTP_STATUS), "processing-failed", "worker-interrupted", "response-unknown", "expired", "internal"]);
const INTERNAL_IMPORT_DETAIL = /cost|budget|reserv|paid|bill|usage|accounting|token|model|reasoning|provider|secret|configuration|fallback|maxCalls|maxInput|maxOutput|priceVersion|\bUSD\b|\$|gpt[- ]|openai|sk-|AIza|Bearer|https?:|api[-_ ]?key|authorization/i;
const SAFE_PUBLIC_IMPORT_MESSAGES = new Set([
  "Sign in to use supplier import.", "Sign in to continue.", "Your session expired. Sign in again.",
  "A current signed-in session is required.", "Verify your email address before continuing.",
  "This account is no longer available.", "Your current account no longer permits this action.",
  "An active subscription with the required hotel module is required.", "Unsupported hotel feature.",
  "supplierproducts.read is required for this hotel.", "supplierproducts.create is required for this hotel.",
  "Only the user who started this import can review its source and proposal.",
  "This AI import was not found in the selected hotel.", "This AI import needs operator review.",
  "This AI import expired. Start a new import.", "The AI import expired. Start a new import.",
  "This import expired and its source is no longer available. Start a new import.",
  "This upload expired. Start a new import.", "This request ID belongs to a different import.",
  "Choose an active supplier in this hotel.", "The selected supplier is no longer active.",
  "Refresh the supplier import page before starting a new import.",
  "Upload a non-empty file no larger than 10 MiB.", "Select a CSV, XLSX, PDF, DOCX, EML or TXT file.",
  "Use GET or POST.", "Use a binary file upload.", "The import source or supplier changed.",
  "The import worker changed.", "The complete import source no longer matches its saved progress.",
  "The import source expired. Start a new import.",
  "No supplier product rows were identified. Check the source or use template import.",
  "The AI output was truncated. Import a smaller file; no partial result was accepted.",
  "The AI response did not complete.", "The AI could not propose a complete supplier import.",
  "The AI returned an empty or oversized proposal.", "The AI proposal is not valid structured data.",
  "The extracted source is too large. Split the file before importing.",
  "The source contains more than 1,000 proposed products. No partial proposal was accepted.",
  "The source has more than 1,000 rows. Split the file.",
  "The source exceeds 1,000 product rows plus one header; split the source.",
  "The workbook exceeds 1,000 data rows across its worksheets; split it.",
  "The file exceeds the 10 MiB limit.", "The source has more than 128 columns.",
  "The file extension does not match the declared content type.",
  "The uploaded file is not an XLSX workbook.", "The uploaded file is not a DOCX document.",
  "The file is not a complete PDF document.", "The CSV contains invalid quoting or an oversized record.",
  "The source contains unsupported or invalid text encoding.",
  "The email has no supported body text. Upload relevant attachments separately.",
  "Choose the import price basis, currency and optional VAT rate before uploading.",
  "Refresh the import form before uploading.", "Choose net, gross or explicitly unknown source pricing.",
  "Choose a supported ISO currency for this import.",
  "Choose an explicit VAT fraction between zero and one, or leave VAT unknown.",
  "Choose a VAT fraction with at most six decimal places, or leave VAT unknown.",
  "The import settings could not be read. Refresh the import form.",
  "This import has inconsistent saved business settings. Start a new import.",
  "This import uses an unsupported business policy. Start a new import.",
]);
const SAFE_PUBLIC_ID_MESSAGE = /^(hotelUid|supplierId|jobId|requestId) (must be a valid document ID|contains unsupported characters)\.$/;
function publicImportError(error = {}) {
  const code = PUBLIC_ERROR_CODES.has(error.code) ? error.code : "internal";
  if (code === "response-unknown") return { code, message: "The import result could not be confirmed. No products were changed. Contact your hotel administrator before starting another import." };
  if (code === "worker-interrupted") return { code, message: "The import stopped before the proposal was ready. No products were changed. Start a new import or contact your hotel administrator." };
  if (["internal", "processing-failed"].includes(code)) return { code, message: "The supplier import could not be prepared. Try again later or contact your hotel administrator." };
  const message = typeof error.message === "string" ? error.message : "";
  // Billing and provider configuration are operator information. A public status,
  // replay or transport error must never disclose them through message copy.
  if (!message || INTERNAL_IMPORT_DETAIL.test(message) || !SAFE_PUBLIC_IMPORT_MESSAGES.has(message) && !SAFE_PUBLIC_ID_MESSAGE.test(message)) return { code, message: code === "resource-exhausted"
    ? "This import cannot be completed right now. Try a smaller file or contact your hotel administrator."
    : "This import needs administrator assistance before it can continue." };
  return { code, message: message.slice(0, 1000) };
}
function publicWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings.slice(0, 100).filter((warning) => warning && typeof warning.code === "string" && typeof warning.message === "string").map((warning) => ({
    code: INTERNAL_IMPORT_DETAIL.test(warning.code) ? "IMPORT_NOTICE" : warning.code.slice(0, 100),
    message: INTERNAL_IMPORT_DETAIL.test(warning.message) ? "This import needs administrator assistance before it can continue." : warning.message.slice(0, 1000),
    ...(Number.isSafeInteger(warning.count) && warning.count >= 0 ? { count: warning.count } : {}),
    ...(Array.isArray(warning.sourceIds) ? { sourceIds: warning.sourceIds.filter((id) => typeof id === "string").slice(0, 20).map((id) => id.slice(0, 200)) } : {}),
  }));
}
function publicJob(job) {
  const purchaseUnitMappingSnapshot = publicMappingSnapshot(job);
  const totalChunks = Number.isSafeInteger(job.totalChunks) && job.totalChunks > 0 ? job.totalChunks : null;
  const completedChunks = Number.isSafeInteger(job.completedChunks) && job.completedChunks >= 0 ? job.completedChunks : 0;
  const totalRows = Number.isSafeInteger(job.totalRows) && job.totalRows >= 0 && job.totalRows <= 1000 ? job.totalRows : null;
  const countKeys = ["new", "changed", "unchanged", "blocked"];
  const countsValid = job.counts && countKeys.every((key) => Number.isSafeInteger(job.counts[key]) && job.counts[key] >= 0 && job.counts[key] <= 1000)
    && (totalRows === null || countKeys.reduce((sum, key) => sum + job.counts[key], 0) === totalRows);
  const counts = countsValid ? Object.fromEntries(countKeys.map((key) => [key, job.counts[key]])) : null;
  return { hotelUid: job.hotelUid, jobId: job.jobId, supplierId: job.supplierId, ownerUid: job.ownerUid, status: job.status,
    importReviewVersion: job.importReviewVersion === REVIEW_WORKSPACE_VERSION ? REVIEW_WORKSPACE_VERSION : null,
    ...(job.recurringImportVersion === 1 ? { recurringImportVersion: 1, sourceFormatProfileVersion: 1 } : {}),
    mappingProfileId: purchaseUnitMappingSnapshot?.profileId ?? null, sourceFormat: purchaseUnitMappingSnapshot?.sourceFormat ?? null,
    purchaseUnitMappingSnapshot,
    ...(job.sourceInterpretation ? { sourceInterpretation: publicSourceInterpretation(job.sourceInterpretation) } : {}),
    ...(job.sourceFormatCandidate ? { sourceFormatCandidate: publicSourceFormatCandidate(job.sourceFormatCandidate) } : {}),
    source: { fileName: job.fileName, size: job.size, mimeType: job.mimeType }, expiresAtMillis: job.expiresAtMillis,
    counts, totalRows, importSettings: publicImportSettings(job), summary: publicSummary(job), warnings: publicWarnings(job.warnings), progress: { completedChunks, totalChunks },
    ...(job.errorCode ? { error: publicImportError({ code: job.errorCode, message: job.errorMessage }) } : {}) };
}
function publicSourceInterpretation(value) {
  if (!value || value.version !== 1 || !["confirmed", "review-required", "unconfirmed"].includes(value.status)) return null;
  return { version: 1, status: value.status, requiresFormatReview: value.requiresFormatReview === true, profileId: typeof value.profileId === "string" ? value.profileId.slice(0, 80) : "default",
    profileRevision: Number.isSafeInteger(value.profileRevision) ? value.profileRevision : 0, formatFingerprint: /^[a-f0-9]{64}$/.test(value.formatFingerprint) ? value.formatFingerprint : null,
    reason: ["multiple-tables", "changed-format", "unconfirmed-format"].includes(value.reason) ? value.reason : null,
    assortmentMode: ["full", "partial", "unknown"].includes(value.assortmentMode) ? value.assortmentMode : "unknown",
    documentPurpose: ["price-list", "product-list", "statistics"].includes(value.documentPurpose) ? value.documentPurpose : "product-list" };
}
function publicSourceFormatCandidate(value) {
  if (!value || value.version !== 1 || !["csv", "xlsx"].includes(value.sourceFormat) || !Array.isArray(value.header) || value.header.length > 128
    || value.header.some((label) => typeof label !== "string" || label.length > 8192) || !/^[a-f0-9]{64}$/.test(value.formatFingerprint)) return null;
  const columns = Object.fromEntries(require("./supplierImportMappings").INTERPRETATION_COLUMNS.filter((field) => Number.isInteger(value.columns?.[field])
    && value.columns[field] >= 0 && value.columns[field] < value.header.length).map((field) => [field, value.columns[field]]));
  return { version: 1, sourceFormat: value.sourceFormat, header: [...value.header], sheetName: typeof value.sheetName === "string" ? value.sheetName.slice(0, 100) : null,
    formatFingerprint: value.formatFingerprint, columns, defaults: {}, assortmentMode: ["full", "partial", "unknown"].includes(value.assortmentMode) ? value.assortmentMode : "unknown",
    documentPurpose: ["price-list", "product-list", "statistics"].includes(value.documentPurpose) ? value.documentPurpose : "product-list",
    decimalSeparator: [".", ","].includes(value.decimalSeparator) ? value.decimalSeparator : ".", dateFormat: ["YYYY-MM-DD", "DD/MM/YYYY"].includes(value.dateFormat) ? value.dateFormat : "YYYY-MM-DD" };
}
function publicMappingSnapshot(job) {
  if (job.importReviewVersion !== REVIEW_WORKSPACE_VERSION || !job.purchaseUnitMappingSnapshot) return null;
  try {
    const scope = mappingScope({ supplierId: job.supplierId, sourceFormat: job.fileName.split(".").at(-1).toLowerCase(), profileId: job.mappingProfileId || "default" });
    return mappingSnapshot(job.purchaseUnitMappingSnapshot, scope);
  } catch { return null; }
}
async function savePrivate(bucket, path, bytes, contentType) {
  const file = bucket.file(path), sha256 = hashOf(bytes);
  try { await file.save(bytes, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: {
    contentType, cacheControl: "private, no-store", metadata: { sha256, policyVersion: String(AI_POLICY_VERSION) } } }); }
  catch (error) { if (Number(error.code) !== 412) throw error; }
  const [metadata] = await file.getMetadata();
  if (metadata.metadata?.sha256 !== sha256 || Number(metadata.size) !== bytes.length || metadata.contentType !== contentType
    || metadata.metadata?.firebaseStorageDownloadTokens || metadata.contentEncoding && metadata.contentEncoding !== "identity") throw new HttpsError("already-exists", "This import object belongs to different content.");
  return { path, generation: validGeneration(metadata.generation), sha256, size: bytes.length, contentType };
}
async function readPrivate(bucket, object, maximumBytes) {
  if (!object || !object.path.startsWith(prefix + "/") || !Number.isSafeInteger(object.size) || object.size < 1 || object.size > maximumBytes) throw new HttpsError("failed-precondition", "The import object is invalid.");
  const file = bucket.file(object.path, { generation: validGeneration(object.generation) }), [metadata] = await file.getMetadata();
  if (metadata.generation !== object.generation || metadata.metadata?.sha256 !== object.sha256 || Number(metadata.size) !== object.size
    || metadata.contentType !== object.contentType || metadata.metadata?.firebaseStorageDownloadTokens
    || metadata.contentEncoding && metadata.contentEncoding !== "identity") throw new HttpsError("failed-precondition", "The import object does not match its snapshot.");
  const [bytes] = await file.download({ decompress: false });
  if (bytes.length !== object.size || hashOf(bytes) !== object.sha256) throw new HttpsError("failed-precondition", "The import source changed.");
  return bytes;
}
async function configurationFor(db, job, transaction) {
  const current = await loadSupplierAiConfiguration(db, transaction);
  if (!current.enabled && job.processingMode !== "deterministic") throw new HttpsError("failed-precondition", "AI supplier import is disabled by the platform operator.");
  // An existing job cannot gain a larger budget or more powerful settings after it starts.
  return { ...current, maxCostPerImportUsd: Math.min(current.maxCostPerImportUsd, job.configuration.maxCostPerImportUsd),
    maxMonthlyCostPerHotelUsd: Math.min(current.maxMonthlyCostPerHotelUsd, job.configuration.maxMonthlyCostPerHotelUsd),
    maxInputTokens: Math.min(current.maxInputTokens, job.configuration.maxInputTokens), maxOutputTokens: Math.min(current.maxOutputTokens, job.configuration.maxOutputTokens),
    maxCallsPerImport: Math.min(current.maxCallsPerImport, job.configuration.maxCallsPerImport), reasoningEffort: job.configuration.reasoningEffort };
}
async function uploadSupplierAiImport(request, data, bytes, services = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_SOURCE_BYTES) throw new HttpsError("invalid-argument", "Upload a non-empty file no larger than 10 MiB.");
  const hotelUid = strictId(data.hotelUid, "hotelUid"), supplierId = strictId(data.supplierId, "supplierId"), requestId = strictId(data.requestId, "requestId");
  if (typeof data.fileName !== "string" || data.fileName.length > 180 || /[/\\\u0000-\u001f]/.test(data.fileName)
    || !/\.(csv|xlsx|pdf|docx|eml|txt)$/i.test(data.fileName)) throw new HttpsError("invalid-argument", "Select a CSV, XLSX, PDF, DOCX, EML or TXT file.");
  const mimeType = typeof data.mimeType === "string" && data.mimeType.length <= 150 ? data.mimeType : "";
  const importSettings = data.importSettings === undefined ? undefined : parseImportSettings(data.importSettings);
  const reviewRequested = data.reviewWorkspaceVersion !== undefined;
  const recurringRequested = data.recurringImportVersion !== undefined;
  if (recurringRequested && ![1, "1"].includes(data.recurringImportVersion)) throw new HttpsError("invalid-argument", "Refresh the supplier import page before starting a new import.");
  if (reviewRequested && ![REVIEW_WORKSPACE_VERSION, String(REVIEW_WORKSPACE_VERSION)].includes(data.reviewWorkspaceVersion)) throw new HttpsError("invalid-argument", "Refresh the supplier import page before starting a new import.");
  if (!reviewRequested && data.mappingProfileId !== undefined) throw new HttpsError("invalid-argument", "Refresh the supplier import page before starting a new import.");
  if (recurringRequested && !reviewRequested) throw new HttpsError("invalid-argument", "Refresh the supplier import page before starting a new import.");
  const mappingProfile = reviewRequested ? mappingScope({ supplierId, sourceFormat: data.fileName.split(".").at(-1).toLowerCase(), profileId: data.mappingProfileId ?? "default" }) : null;
  const db = services.firestore || admin.firestore(), bucket = services.bucket || admin.storage().bucket();
  const now = services.now?.() ?? Date.now(), month = new Date(now).toISOString().slice(0, 7), day = new Date(now).toISOString().slice(0, 10);
  const sha256 = hashOf(bytes), fingerprint = reviewRequested ? digest(supplierId, data.fileName, mimeType, sha256, IMPORT_POLICY_VERSION, importSettings,
    { reviewWorkspaceVersion: REVIEW_WORKSPACE_VERSION, mappingProfileId: mappingProfile.profileId, ...(recurringRequested ? { recurringImportVersion: 1 } : {}) }) : importSettings ? digest(supplierId, data.fileName, mimeType, sha256, IMPORT_POLICY_VERSION, importSettings)
    : digest(supplierId, data.fileName, mimeType, sha256);
  const jobId = digest(hotelUid, requestId, request.auth?.uid, fingerprint);
  const refs = references(db, hotelUid, jobId, month, requestId);
  await authorize(db, request, hotelUid, "create", undefined, services);
  // A confirmed recurring table is parsed without provider access. Parsing is
  // bounded and read-only; the profile revision is still frozen transactionally.
  let structuredSource = null;
  const existingReceipt = await refs.request.get();
  if (!existingReceipt.exists && recurringRequested && reviewRequested && ["csv", "xlsx"].includes(mappingProfile.sourceFormat)) {
    await requireHotelPermission(db, { auth: request.auth }, hotelUid, "suppliers", "read", undefined, services.auth);
    const profile = await mappingProfileRef(db, hotelUid, mappingProfile).get();
    if (profile.exists && profile.data().interpretation) structuredSource = await (services.extractSource || require("./supplierAiExtraction").extractSupplierAiSource)({ bytes, fileName: data.fileName, mimeType });
  }
  const pending = await db.runTransaction(async (tx) => {
    await authorize(db, request, hotelUid, "create", tx, services);
    const [stored, job, supplier, usage, state] = await Promise.all([tx.get(refs.request), tx.get(refs.job), tx.get(db.doc(`hotels/${hotelUid}/suppliers/${supplierId}`)), tx.get(refs.month), tx.get(refs.state)]);
    const active = activeState(state);
    if (stored.exists) {
      if (stored.data().ownerUid !== request.auth.uid || stored.data().fingerprint !== fingerprint) throw new HttpsError("already-exists", "This request ID belongs to a different import.");
      if (!importSettings && (stored.data().importPolicyVersion !== undefined && stored.data().importPolicyVersion !== 1 || Object.hasOwn(stored.data(), "importSettings")
        || stored.data().jobId !== jobId)) throw new HttpsError("invalid-argument", "Choose the import price basis, currency and optional VAT rate before uploading.");
      if (stored.data().expiresAtMillis <= now) throw new HttpsError("failed-precondition", "This upload expired. Start a new import.");
      if (job.exists) {
        if (!importSettings && settingsForJob(job.data()) !== undefined) throw new HttpsError("failed-precondition", "This import has inconsistent saved business settings. Start a new import.");
        return { job: job.data() };
      }
      if (stored.data().quotaReleased) {
        const oldMonthRef = db.doc(`hotels/${hotelUid}/aiUsageMonths/${stored.data().month}`);
        const oldMonth = stored.data().month === month ? usage : await tx.get(oldMonthRef);
        const config = await loadSupplierAiConfiguration(db, tx), next = normalizeMonth(oldMonth, stored.data().month);
        if (!config.enabled && stored.data().processingMode !== "deterministic" || active.activeJobs >= config.maxConcurrentJobsPerHotel) throw new HttpsError("resource-exhausted", "AI import is disabled or this hotel has reached its concurrent limit.");
        tx.update(refs.request, { quotaReleased: false, pendingUntil: admin.firestore.Timestamp.fromMillis(now + LEASE_MS) });
        tx.set(oldMonthRef, { ...next, activeJobs: next.activeJobs + 1, updatedAt: stamp() });
        tx.set(refs.state, { ...active, activeJobs: active.activeJobs + 1, updatedAt: stamp() });
      }
      return { receipt: stored.data() };
    }
    if (!importSettings) throw new HttpsError("invalid-argument", "Choose the import price basis, currency and optional VAT rate before uploading.");
    if (!reviewRequested) throw new HttpsError("failed-precondition", "Refresh the supplier import page before starting a new import.");
    await requireHotelPermission(db, { auth: request.auth }, hotelUid, "suppliers", "read", tx, services.auth);
    const profile = await tx.get(mappingProfileRef(db, hotelUid, mappingProfile));
    const purchaseUnitMappingSnapshot = mappingSnapshot(profile.exists ? profile.data() : null, mappingProfile);
    const processingMode = structuredSource && require("./supplierImportFormat").interpretationForSources(structuredSource, purchaseUnitMappingSnapshot, { importSettings }).sourceInterpretation.status === "confirmed" ? "deterministic" : "ai";
    const configuration = await loadSupplierAiConfiguration(db, tx);
    if (!configuration.enabled && processingMode !== "deterministic") throw new HttpsError("failed-precondition", "AI supplier import is disabled by the platform operator.");
    if (!supplier.exists || supplier.data().archived === true) throw new HttpsError("failed-precondition", "Choose an active supplier in this hotel.");
    const next = normalizeMonth(usage, month);
    if (active.activeJobs >= configuration.maxConcurrentJobsPerHotel || (next.days[day] || 0) >= configuration.maxImportsPerHotelPerDay
      || processingMode !== "deterministic" && next.knownCostMicros + next.reservedCostMicros >= configuration.maxMonthlyCostPerHotelUsd * 1000000) throw new HttpsError("resource-exhausted", "This hotel has reached its AI import budget or concurrent/daily limit.");
    const authTime = request.auth.token.auth_time;
    if (!Number.isFinite(authTime)) throw new HttpsError("unauthenticated", "A current signed-in session is required.");
    const receipt = { hotelUid, jobId, requestId, supplierId, ownerUid: request.auth.uid, authTime, fingerprint,
      importPolicyVersion: IMPORT_POLICY_VERSION, importSettings,
      importReviewVersion: REVIEW_WORKSPACE_VERSION, mappingProfileId: mappingProfile.profileId, purchaseUnitMappingSnapshot, processingMode,
      ...(recurringRequested ? { recurringImportVersion: 1, sourceFormatProfileVersion: 1 } : {}),
      fileName: data.fileName, mimeType, size: bytes.length, sha256, month, configuration, configVersion: configuration.revision,
      configPolicyVersion: AI_POLICY_VERSION, expiresAtMillis: now + SOURCE_RETENTION_MS, expiresAt: admin.firestore.Timestamp.fromMillis(now + SOURCE_RETENTION_MS), createdAt: stamp() };
    receipt.cleanupPending = true; receipt.quotaReleased = false; receipt.pendingUntil = admin.firestore.Timestamp.fromMillis(now + LEASE_MS);
    tx.create(refs.request, receipt);
    tx.set(refs.month, { ...next, activeJobs: next.activeJobs + 1, importsStarted: next.importsStarted + 1,
      days: { ...next.days, [day]: (next.days[day] || 0) + 1 }, updatedAt: stamp() });
    tx.set(refs.state, { ...active, activeJobs: active.activeJobs + 1, updatedAt: stamp() });
    return { receipt };
  });
  if (pending.job) return publicJob(await settleExpiredAttempt(db, pending.job, services));
  const receipt = pending.receipt;
  let source;
  try { source = await savePrivate(bucket, `${prefix}/${hotelUid}/${jobId}/source`, bytes, "application/octet-stream"); }
  catch (error) {
    const releaseRefs = references(db, hotelUid, jobId, receipt.month, requestId);
    await db.runTransaction(async (tx) => {
      const [stored, job, usage, state] = await Promise.all([tx.get(releaseRefs.request), tx.get(releaseRefs.job), tx.get(releaseRefs.month), tx.get(releaseRefs.state)]);
      if (!job.exists && stored.exists && !stored.data().quotaReleased) {
        const next = normalizeMonth(usage, receipt.month);
        tx.update(releaseRefs.request, { quotaReleased: true });
        tx.set(releaseRefs.month, { ...next, activeJobs: Math.max(0, next.activeJobs - 1), updatedAt: stamp() });
        const active = activeState(state);
        tx.set(releaseRefs.state, { ...active, activeJobs: Math.max(0, active.activeJobs - 1), updatedAt: stamp() });
      }
    });
    throw error;
  }
  return db.runTransaction(async (tx) => {
    await authorize(db, request, hotelUid, "create", tx, services);
    const configuration = await configurationFor(db, receipt, tx), quotaRefs = references(db, hotelUid, jobId, receipt.month, requestId);
    const [stored, previous, supplier, month, state] = await Promise.all([tx.get(refs.request), tx.get(refs.job), tx.get(db.doc(`hotels/${hotelUid}/suppliers/${supplierId}`)), tx.get(quotaRefs.month), tx.get(quotaRefs.state)]);
    if (previous.exists) return publicJob(previous.data());
    if (!stored.exists || stored.data().fingerprint !== fingerprint || !supplier.exists || supplier.data().archived === true) throw new HttpsError("aborted", "The import source or supplier changed.");
    const monthly = normalizeMonth(month, receipt.month), active = activeState(state);
    if (stored.data().quotaReleased) {
      // Failed concurrent uploads or maintenance may release a receipt while another
      // identical source write is in flight. Finalization reacquires quota atomically.
      if (active.activeJobs >= configuration.maxConcurrentJobsPerHotel) throw new HttpsError("resource-exhausted", "This hotel has reached its concurrent AI import limit.");
      tx.set(quotaRefs.month, { ...monthly, activeJobs: monthly.activeJobs + 1, updatedAt: stamp() });
      tx.set(quotaRefs.state, { ...active, activeJobs: active.activeJobs + 1, updatedAt: stamp() });
    } else if (monthly.activeJobs < 1 || active.activeJobs < 1) throw new HttpsError("failed-precondition", "The import quota reservation needs operator review.");
    const job = { ...receipt, actorUid: receipt.ownerUid, status: "queued", source, policyVersion: AI_POLICY_VERSION,
      completedChunks: 0, attemptedCalls: 0, succeededCalls: 0, unknownCalls: 0, countingCalls: 0,
      knownCostMicros: 0, reservedCostMicros: 0, inputTokens: 0, outputTokens: 0, quotaReleased: false, updatedAt: stamp() };
    job.recoverAfter = admin.firestore.Timestamp.fromMillis((services.now?.() ?? Date.now()) + LEASE_MS);
    tx.create(refs.job, job);
    tx.update(refs.request, { pendingUntil: admin.firestore.FieldValue.delete(), quotaReleased: false });
    tx.create(db.doc(`hotels/${hotelUid}/supplierAiImportWork/${jobId}`), { hotelUid, jobId, createdAt: stamp() });
    return publicJob(job);
  });
}
async function finishJob(db, job, status, error, patch = {}) {
  const refs = references(db, job.hotelUid, job.jobId, job.month);
  return db.runTransaction(async (tx) => {
    const [current, month, state] = await Promise.all([tx.get(refs.job), tx.get(refs.month), tx.get(refs.state)]);
    if (!current.exists || job.leaseId && current.data().leaseId !== job.leaseId || TERMINAL.has(current.data().status)) return current.exists ? current.data() : null;
    const data = current.data(), usage = normalizeMonth(month, job.month);
    const update = { status, leaseUntil: 0, leaseId: admin.firestore.FieldValue.delete(), recoverAfter: admin.firestore.FieldValue.delete(), quotaReleased: true, updatedAt: stamp(), ...patch,
      ...(error ? { errorCode: error.code, errorMessage: error.message } : {}) };
    tx.update(refs.job, update);
    if (!data.quotaReleased) {
      tx.set(refs.month, { ...usage, activeJobs: Math.max(0, usage.activeJobs - 1),
      importsReviewReady: usage.importsReviewReady + (status === "review" ? 1 : 0), importsFailed: usage.importsFailed + (status !== "review" ? 1 : 0), updatedAt: stamp() });
      const active = activeState(state);
      tx.set(refs.state, { ...active, activeJobs: Math.max(0, active.activeJobs - 1), updatedAt: stamp() });
    }
    return { ...data, ...update };
  });
}
async function settleExpiredAttempt(db, job, services = {}) {
  if (!["processing", "queued"].includes(job.status) || (job.leaseUntil || job.recoverAfter?.toMillis?.() || Infinity) > (services.now?.() ?? Date.now())) return job;
  const refs = references(db, job.hotelUid, job.jobId, job.month);
  return db.runTransaction(async (tx) => {
    const [current, monthly, state] = await Promise.all([tx.get(refs.job), tx.get(refs.month), tx.get(refs.state)]);
    if (!current.exists || !["processing", "queued"].includes(current.data().status)
      || (current.data().leaseUntil || current.data().recoverAfter?.toMillis?.() || Infinity) > (services.now?.() ?? Date.now())) return current.data();
    const data = current.data();
    const attemptRef = data.currentAttemptId ? db.doc(`${refs.job.path}/attempts/${data.currentAttemptId}`) : null, attempt = attemptRef ? await tx.get(attemptRef) : null;
    const unknown = attempt?.exists && attempt.data().status === "attempted";
    const usage = normalizeMonth(monthly, data.month);
    const billingMonth = unknown ? attempt.data().billingMonth : data.month;
    const billingRef = db.doc(`hotels/${job.hotelUid}/aiUsageMonths/${billingMonth}`);
    const billingUsage = billingMonth === data.month ? usage : normalizeMonth(await tx.get(billingRef), billingMonth);
    const errorCode = unknown ? "response-unknown" : "worker-interrupted";
    const errorMessage = unknown ? "The AI request may have been charged. The reservation is retained; no automatic retry will occur." : "The import worker stopped before completing the proposal. Start a new import; confirmed costs remain recorded.";
    if (unknown) tx.update(attemptRef, { status: "response_unknown", errorCode: "worker-interrupted", updatedAt: stamp() });
    tx.update(refs.job, { status: unknown ? "response_unknown" : "failed", unknownCalls: data.unknownCalls + (unknown ? 1 : 0), quotaReleased: true,
      errorCode, errorMessage, leaseUntil: 0, recoverAfter: admin.firestore.FieldValue.delete(), updatedAt: stamp() });
    tx.set(refs.month, { ...usage, unknownCalls: usage.unknownCalls + (unknown && billingMonth === data.month ? 1 : 0), importsFailed: usage.importsFailed + 1,
      activeJobs: usage.activeJobs - (data.quotaReleased ? 0 : 1), updatedAt: stamp() });
    if (unknown && billingMonth !== data.month) tx.set(billingRef, { ...billingUsage, unknownCalls: billingUsage.unknownCalls + 1, updatedAt: stamp() });
    const active = activeState(state);
    tx.set(refs.state, { ...active, activeJobs: Math.max(0, active.activeJobs - (data.quotaReleased ? 0 : 1)), updatedAt: stamp() });
    return { ...data, status: unknown ? "response_unknown" : "failed", unknownCalls: data.unknownCalls + (unknown ? 1 : 0), quotaReleased: true,
      errorCode, errorMessage };
  });
}
async function readSupplierAiImport(request, data, services = {}) {
  const hotelUid = strictId(data.hotelUid, "hotelUid"), db = services.firestore || admin.firestore();
  await authorize(db, request, hotelUid, "read", undefined, services);
  if (data.jobId == null) {
    await authorize(db, request, hotelUid, "create", undefined, services);
    const [config, hotel, bootstrap] = await Promise.all([loadSupplierAiConfiguration(db), db.doc(`hotels/${hotelUid}`).get(), db.doc(`hotels/${hotelUid}/settings/bootstrap`).get()]);
    const currency = hotel.data()?.currency;
    const suggestedCurrency = typeof currency === "string" && currencyCodes.has(currency)
      && (!bootstrap.exists || bootstrap.data()?.currency === currency) ? currency : null;
    await authorize(db, request, hotelUid, "create", undefined, services);
    return { available: true, aiAvailable: config.enabled, recurringFormatsAvailable: true, recurringImportVersion: 1, sourceFormatProfileVersion: 1,
      importPolicyVersion: IMPORT_POLICY_VERSION, reviewWorkspaceVersion: REVIEW_WORKSPACE_VERSION, reason: config.enabled ? null : "disabled",
      limits: { maxFileBytes: MAX_SOURCE_BYTES, maxPages: 50, maxProducts: 1000 }, defaults: { currency: suggestedCurrency } };
  }
  const ref = db.doc(`hotels/${hotelUid}/supplierAiImportJobs/${strictId(data.jobId, "jobId")}`), stored = await ref.get();
  if (!stored.exists) throw new HttpsError("not-found", "This AI import was not found in the selected hotel.");
  if (stored.data().ownerUid !== request.auth.uid) throw new HttpsError("permission-denied", "Only the user who started this import can review its source and proposal.");
  if (stored.data().expiresAtMillis <= (services.now?.() ?? Date.now())) throw new HttpsError("failed-precondition", "This import expired and its source is no longer available. Start a new import.");
  const job = await settleExpiredAttempt(db, stored.data(), services);
  await authorize(db, request, hotelUid, "read", undefined, services);
  return publicJob(job);
}
async function countChunk(db, job, body, provider, services) {
  const billingMonth = billingMonthOf(services), refs = references(db, job.hotelUid, job.jobId, billingMonth), countId = `count-${randomUUID()}`;
  await db.runTransaction(async (tx) => {
    await authorize(db, actorRequest(job), job.hotelUid, "create", tx, services);
    await configurationFor(db, job, tx);
    const [current, monthly] = await Promise.all([tx.get(refs.job), tx.get(refs.month)]);
    if (current.data()?.leaseId !== job.leaseId) throw new HttpsError("aborted", "The AI import worker changed.");
    const usage = normalizeMonth(monthly, billingMonth);
    tx.create(db.doc(`${refs.job.path}/attempts/${countId}`), { kind: "token_count", status: "attempted", model: body.model,
      priceVersion: PRICE_VERSION, billingMonth, inputTokens: null, outputTokens: null, costMicros: null, reservedCostMicros: 0, createdAt: stamp() });
    tx.update(refs.job, { countingCalls: current.data().countingCalls + 1, leaseUntil: (services.now?.() ?? Date.now()) + LEASE_MS });
    tx.set(refs.month, { ...usage, countingCalls: usage.countingCalls + 1, updatedAt: stamp() });
  });
  let inputTokens;
  try { inputTokens = await provider.countInput(body); }
  catch (error) {
    await db.doc(`${refs.job.path}/attempts/${countId}`).set({ status: "failed", updatedAt: stamp() }, { merge: true });
    throw error;
  }
  await db.doc(`${refs.job.path}/attempts/${countId}`).set({ status: "succeeded", inputTokens, updatedAt: stamp() }, { merge: true });
  return inputTokens;
}
async function executeChunk(db, bucket, job, source, index, provider, services) {
  let refs = references(db, job.hotelUid, job.jobId, job.month);
  const attemptId = `chunk-${String(index).padStart(4, "0")}`;
  const attemptRef = db.doc(`${refs.job.path}/attempts/${attemptId}`), existing = await attemptRef.get();
  if (existing.exists) {
    if (existing.data().status !== "succeeded") throw new HttpsError("failed-precondition", "A prior AI request remains unconfirmed. No automatic retry is allowed.");
    return JSON.parse((await readPrivate(bucket, existing.data().result, 4 * 1024 * 1024)).toString("utf8"));
  }
  const importSettings = settingsForJob(job);
  const purchaseUnitMappingSnapshot = job.importReviewVersion === REVIEW_WORKSPACE_VERSION ? publicMappingSnapshot(job) : undefined;
  if (job.importReviewVersion !== undefined && job.importReviewVersion !== REVIEW_WORKSPACE_VERSION || job.importReviewVersion === REVIEW_WORKSPACE_VERSION && !purchaseUnitMappingSnapshot) throw new HttpsError("failed-precondition", "The supplier purchase-unit profile needs review.");
  const proposals = require("./supplierAiProposal");
  const configuration = await configurationFor(db, job), schema = services.schema || (importSettings ? proposals.AI_SUPPLIER_SCHEMA_V2 : proposals.AI_SUPPLIER_SCHEMA);
  const body = createSupplierAiRequest(source, configuration, schema, importSettings), requestDigest = hashOf(Buffer.from(JSON.stringify(body)));
  const countedTokens = await countChunk(db, job, body, provider, services), reservedInput = inputReservationTokens(countedTokens);
  const billingMonth = billingMonthOf(services);
  refs = references(db, job.hotelUid, job.jobId, billingMonth);
  const reservation = costMicros(reservedInput, configuration.maxOutputTokens);
  const reserved = await db.runTransaction(async (tx) => {
    await authorize(db, actorRequest(job), job.hotelUid, "create", tx, services);
    const currentConfiguration = await configurationFor(db, job, tx);
    const [current, monthly, previous, supplier] = await Promise.all([tx.get(refs.job), tx.get(refs.month), tx.get(attemptRef), tx.get(db.doc(`hotels/${job.hotelUid}/suppliers/${job.supplierId}`))]);
    const data = current.data(), usage = normalizeMonth(monthly, billingMonth);
    if (!data || data.leaseId !== job.leaseId || data.status !== "processing" || previous.exists) throw new HttpsError("aborted", "The AI import attempt changed.");
    if (!supplier.exists || supplier.data().archived === true) throw new HttpsError("failed-precondition", "The selected supplier is no longer active.");
    if (countedTokens > currentConfiguration.maxInputTokens || body.max_output_tokens > currentConfiguration.maxOutputTokens
      || data.attemptedCalls >= currentConfiguration.maxCallsPerImport || reservedInput + body.max_output_tokens > 272000
      || data.knownCostMicros + data.reservedCostMicros + reservation > currentConfiguration.maxCostPerImportUsd * 1000000
      || usage.knownCostMicros + usage.reservedCostMicros + reservation > currentConfiguration.maxMonthlyCostPerHotelUsd * 1000000) throw new HttpsError("resource-exhausted", "The complete import cannot continue within its input, call or cost limit. No partial proposal was accepted.");
    tx.create(attemptRef, { kind: "response", status: "attempted", chunkIndex: index, requestDigest, model: body.model,
      priceVersion: PRICE_VERSION, billingMonth, inputTokens: null, outputTokens: null, costMicros: null, countedInputTokens: countedTokens,
      reservedInputTokens: reservedInput, maximumOutputTokens: body.max_output_tokens, reservedCostMicros: reservation, createdAt: stamp() });
    tx.update(refs.job, { attemptedCalls: data.attemptedCalls + 1, reservedCostMicros: data.reservedCostMicros + reservation,
      currentAttemptId: attemptId, leaseUntil: (services.now?.() ?? Date.now()) + LEASE_MS, updatedAt: stamp() });
    tx.set(refs.month, { ...usage, attemptedCalls: usage.attemptedCalls + 1, reservedCostMicros: usage.reservedCostMicros + reservation, updatedAt: stamp() });
    return true;
  });
  if (!reserved) throw new HttpsError("aborted", "The import reservation failed.");
  let response;
  try { response = await provider.respond(body); }
  catch {
    await markUnknown(db, job, attemptId);
    throw new HttpsError("failed-precondition", "The AI response could not be confirmed. Reserved cost is retained; no automatic retry is allowed.");
  }
  const usage = normalizedProviderUsage(response);
  if (!usage) {
    await markUnknown(db, job, attemptId);
    throw new HttpsError("failed-precondition", "The AI provider accounting could not be verified. Reserved cost is retained; no automatic retry is allowed.");
  }
  const accountingBoundExceeded = usage.inputTokens > reservedInput || usage.outputTokens > body.max_output_tokens || usage.costMicros > reservation;
  // Settle known usage even when the proposal is refused, truncated or semantically invalid.
  await db.runTransaction(async (tx) => {
    const [current, monthly, attempt] = await Promise.all([tx.get(refs.job), tx.get(refs.month), tx.get(attemptRef)]);
    if (current.data()?.leaseId !== job.leaseId || attempt.data()?.status !== "attempted") throw new HttpsError("aborted", "The AI billing receipt changed.");
    const data = current.data(), aggregate = normalizeMonth(monthly, billingMonth);
    tx.update(attemptRef, { status: "charged", ...usage, accountingBoundExceeded, reservedCostMicros: 0, providerResponseId: typeof response.id === "string" ? response.id.slice(0, 120) : null, updatedAt: stamp() });
    tx.update(refs.job, { knownCostMicros: data.knownCostMicros + usage.costMicros, reservedCostMicros: data.reservedCostMicros - reservation,
      inputTokens: data.inputTokens + usage.inputTokens, outputTokens: data.outputTokens + usage.outputTokens, currentAttemptId: admin.firestore.FieldValue.delete() });
    tx.set(refs.month, { ...aggregate, knownCostMicros: aggregate.knownCostMicros + usage.costMicros, reservedCostMicros: aggregate.reservedCostMicros - reservation,
      inputTokens: aggregate.inputTokens + usage.inputTokens, outputTokens: aggregate.outputTokens + usage.outputTokens, updatedAt: stamp() });
  });
  if (accountingBoundExceeded) throw new HttpsError("failed-precondition", "Verified AI usage exceeded the preflight reservation. The recorded cost includes that usage. Processing stopped; the platform operator must investigate before another attempt.");
  const raw = boundedResponseText(response);
  const validate = services.validateRows || require("./supplierAiProposal").validateRawSupplierAiRows;
  const sourceUnits = [...source.units, ...(source.contextUnits || []).map((unit) => ({ ...unit, contextOnly: true }))];
  const validatedRows = validate(raw, { sourceUnits });
  const normalize = services.normalizeRow || require("./supplierAiNormalization").normalizeSupplierAiProposal;
  const rows = importSettings ? validatedRows.map((row) => normalize(row, { importSettings, sourceUnits, purchaseUnitMappingSnapshot,
    sourceInterpretation: job.sourceInterpretation })) : validatedRows;
  await authorize(db, actorRequest(job), job.hotelUid, "create", undefined, services);
  const result = await savePrivate(bucket, `${prefix}/${job.hotelUid}/${job.jobId}/${attemptId}.json`, Buffer.from(JSON.stringify(rows)), "application/json");
  await db.runTransaction(async (tx) => {
    await authorize(db, actorRequest(job), job.hotelUid, "create", tx, services);
    const [current, monthly, attempt] = await Promise.all([tx.get(refs.job), tx.get(refs.month), tx.get(attemptRef)]);
    if (current.data()?.leaseId !== job.leaseId || attempt.data()?.status !== "charged") throw new HttpsError("aborted", "The AI result receipt changed.");
    const aggregate = normalizeMonth(monthly, billingMonth);
    tx.update(attemptRef, { status: "succeeded", result, updatedAt: stamp() });
    tx.update(refs.job, { completedChunks: index + 1, succeededCalls: current.data().succeededCalls + 1, updatedAt: stamp() });
    tx.set(refs.month, { ...aggregate, succeededCalls: aggregate.succeededCalls + 1, updatedAt: stamp() });
  });
  return rows;
}
async function markUnknown(db, job, attemptId) {
  const refs = references(db, job.hotelUid, job.jobId, job.month), attemptRef = db.doc(`${refs.job.path}/attempts/${attemptId}`);
  return db.runTransaction(async (tx) => {
    const [current, monthly, attempt, state] = await Promise.all([tx.get(refs.job), tx.get(refs.month), tx.get(attemptRef), tx.get(refs.state)]);
    if (!current.exists || attempt.data()?.status !== "attempted") return;
    const data = current.data(), usage = normalizeMonth(monthly, job.month);
    const billingMonth = attempt.data().billingMonth, billingRef = db.doc(`hotels/${job.hotelUid}/aiUsageMonths/${billingMonth}`);
    const billingUsage = billingMonth === job.month ? usage : normalizeMonth(await tx.get(billingRef), billingMonth);
    tx.update(attemptRef, { status: "response_unknown", updatedAt: stamp() });
    tx.update(refs.job, { status: "response_unknown", unknownCalls: data.unknownCalls + 1, quotaReleased: true, leaseUntil: 0, recoverAfter: admin.firestore.FieldValue.delete(),
      errorCode: "response-unknown", errorMessage: "The AI response or its billed usage could not be confirmed. The reserved amount is retained. No automatic retry will occur.", updatedAt: stamp() });
    tx.set(refs.month, { ...usage, unknownCalls: usage.unknownCalls + (billingMonth === job.month ? 1 : 0), activeJobs: usage.activeJobs - (data.quotaReleased ? 0 : 1), importsFailed: usage.importsFailed + 1, updatedAt: stamp() });
    if (billingMonth !== job.month) tx.set(billingRef, { ...billingUsage, unknownCalls: billingUsage.unknownCalls + 1, updatedAt: stamp() });
    const active = activeState(state);
    tx.set(refs.state, { ...active, activeJobs: Math.max(0, active.activeJobs - (data.quotaReleased ? 0 : 1)), updatedAt: stamp() });
  });
}
async function queueContinuation(db, job, services) {
  const jobRef = db.doc(`hotels/${job.hotelUid}/supplierAiImportJobs/${job.jobId}`);
  await db.runTransaction(async (tx) => {
    await authorize(db, actorRequest(job), job.hotelUid, "create", tx, services);
    const current = await tx.get(jobRef);
    if (current.data()?.leaseId !== job.leaseId || current.data().status !== "processing") throw new HttpsError("aborted", "The import worker changed.");
    tx.update(jobRef, { status: "queued", leaseUntil: 0, leaseId: admin.firestore.FieldValue.delete(),
      recoverAfter: admin.firestore.Timestamp.fromMillis((services.now?.() ?? Date.now()) + LEASE_MS), updatedAt: stamp() });
    tx.create(db.doc(`hotels/${job.hotelUid}/supplierAiImportWork/${job.jobId}-${randomUUID()}`), { hotelUid: job.hotelUid, jobId: job.jobId, createdAt: stamp() });
  });
  return { queued: true };
}
async function runSupplierAiImportJob(hotelUid, jobId, services = {}) {
  hotelUid = strictId(hotelUid, "hotelUid"); jobId = strictId(jobId, "jobId");
  const started = services.now?.() ?? Date.now();
  const db = services.firestore || admin.firestore(), bucket = services.bucket || admin.storage().bucket(), jobRef = db.doc(`hotels/${hotelUid}/supplierAiImportJobs/${jobId}`);
  const stored = await jobRef.get();
  if (!stored.exists) return { ignored: true };
  await settleExpiredAttempt(db, stored.data(), services);
  let job;
  try {
    job = await db.runTransaction(async (tx) => {
      const current = await tx.get(jobRef);
      if (!current.exists || TERMINAL.has(current.data().status)) return null;
      const data = current.data(), now = services.now?.() ?? Date.now();
      if (data.hotelUid !== hotelUid || data.jobId !== jobId || data.policyVersion !== AI_POLICY_VERSION) throw new HttpsError("failed-precondition", "This AI import needs operator review.");
      settingsForJob(data);
      if (data.expiresAtMillis <= now) throw new HttpsError("failed-precondition", "The AI import expired. Start a new import.");
      if (data.leaseUntil > now) return null;
      await authorize(db, actorRequest(data), hotelUid, "create", tx, services);
      await configurationFor(db, data, tx);
      const leaseId = randomUUID();
      tx.update(jobRef, { status: "processing", leaseId, leaseUntil: now + LEASE_MS, recoverAfter: admin.firestore.Timestamp.fromMillis(now + LEASE_MS), updatedAt: stamp() });
      return { ...data, status: "processing", leaseId };
    });
    if (!job) return { ignored: true };
    const extract = services.extractSource || require("./supplierAiExtraction").extractSupplierAiSource;
    const split = services.splitSource || require("./supplierAiExtraction").splitSupplierAiSource;
    await authorize(db, actorRequest(job), hotelUid, "create", undefined, services);
    if (job.source?.path !== `${prefix}/${hotelUid}/${jobId}/source`) throw new HttpsError("failed-precondition", "The source is outside this import.");
    const bytes = await readPrivate(bucket, job.source, MAX_SOURCE_BYTES);
    const source = await extract({ bytes, fileName: job.fileName, mimeType: job.mimeType });
    await authorize(db, actorRequest(job), hotelUid, "create", undefined, services);
    const formatPlan = job.recurringImportVersion === 1 && source.format ? require("./supplierImportFormat").interpretationForSources(source, publicMappingSnapshot(job), { importSettings: settingsForJob(job) }) : null;
    let sourceFormatObject;
    if (job.recurringImportVersion === 1 && ["csv", "xlsx"].includes(source.format)) {
      const serialized = Buffer.from(JSON.stringify({ format: source.format, sourceSha256: source.sourceSha256, units: source.units, warnings: source.warnings || [] }));
      if (serialized.length > 2 * 1024 * 1024) throw new HttpsError("resource-exhausted", "The extracted source is too large. Split the file before importing.");
      sourceFormatObject = await savePrivate(bucket, `${prefix}/${hotelUid}/${jobId}/source-format.json`, serialized, "application/json");
    }
    if (job.processingMode === "deterministic" && formatPlan?.sourceInterpretation.status !== "confirmed") throw new HttpsError("failed-precondition", "The confirmed source format no longer matches this import.");
    const chunks = job.processingMode === "deterministic" ? [source] : await split(source, { maxUnits: 100, maxPdfPages: 5 });
    if (!Array.isArray(chunks) || !chunks.length || chunks.length > job.configuration.maxCallsPerImport) throw new HttpsError("resource-exhausted", "This source needs too many AI calls. Split the file before importing.");
    await db.runTransaction(async (tx) => {
      const current = await tx.get(jobRef);
      if (current.data()?.leaseId !== job.leaseId || current.data().status !== "processing") throw new HttpsError("aborted", "The import worker changed.");
      if (current.data().totalChunks != null && current.data().totalChunks !== chunks.length) throw new HttpsError("failed-precondition", "The complete import source no longer matches its saved progress.");
      tx.update(jobRef, { totalChunks: chunks.length, ...(formatPlan ? { sourceInterpretation: formatPlan.sourceInterpretation,
        sourceFormatCandidate: formatPlan.sourceFormatCandidate } : {}), ...(sourceFormatObject ? { sourceFormatObject } : {}), updatedAt: stamp() });
    });
    if (formatPlan) job = { ...job, sourceInterpretation: formatPlan.sourceInterpretation, sourceFormatCandidate: formatPlan.sourceFormatCandidate };
    const provider = job.processingMode === "deterministic" ? null : services.provider || createSupplierAiProvider({ apiKey: OPENAI_API_KEY.value() });
    const rows = [];
    for (let index = 0; index < chunks.length; index++) {
      if ((services.now?.() ?? Date.now()) - started > 360000 && index >= (job.completedChunks || 0)) {
        await queueContinuation(db, job, services);
        return { queued: true };
      }
      if (job.processingMode === "deterministic") {
        const parsed = require("./supplierImportFormat").interpretSupplierSourceRows(source, publicMappingSnapshot(job), { importSettings: settingsForJob(job) });
        rows.push(...parsed.rows);
        await db.runTransaction(async (tx) => {
          await authorize(db, actorRequest(job), hotelUid, "create", tx, services);
          const current = await tx.get(jobRef);
          if (current.data()?.leaseId !== job.leaseId || current.data().status !== "processing") throw new HttpsError("aborted", "The import worker changed.");
          tx.update(jobRef, { completedChunks: 1, updatedAt: stamp() });
        });
      } else rows.push(...await executeChunk(db, bucket, job, chunks[index], index, provider, services));
      if (rows.length > 1000) throw new HttpsError("resource-exhausted", "The source contains more than 1,000 proposed products. No partial proposal was accepted.");
    }
    await authorize(db, actorRequest(job), hotelUid, "create", undefined, services);
    if (!rows.length) throw new HttpsError("failed-precondition", "No supplier product rows were identified. Check the source or use template import.");
    const referenced = new Set(rows.flatMap((row) => (row.sourceAnchors || []).filter((anchor) => anchor.verified === true || anchor.evidenceKind === "visual-page").map((anchor) => anchor.sourceId)));
    const possibleOmissions = source.units.filter((unit) => !unit.contextOnly && unit.kind !== "pdf-page"
      && unit.method !== "vision" && !/header/i.test(unit.sourceId) && !referenced.has(unit.sourceId));
    const warnings = [...(source.warnings || []), ...(possibleOmissions.length ? [{ code: "POSSIBLE_OMITTED_SOURCE_ROWS",
      message: `${possibleOmissions.length} source rows were not referenced by any proposed product. Check the source for omitted products, headers or summaries.`,
      sourceIds: possibleOmissions.slice(0, 20).map((unit) => unit.sourceId), count: possibleOmissions.length }] : [])];
    const reconcile = services.reconcileRows || require("./supplierAiProposal").reconcileSupplierAiRows;
    await db.runTransaction(async (tx) => {
      const current = await tx.get(jobRef);
      if (current.data()?.leaseId !== job.leaseId || current.data().status !== "processing") throw new HttpsError("aborted", "The import worker changed.");
      tx.update(jobRef, { leaseUntil: (services.now?.() ?? Date.now()) + LEASE_MS, updatedAt: stamp() });
    });
    const result = await reconcile({ db, hotelUid, supplierId: job.supplierId, jobId, rows, sourceUnits: source.units,
      leaseId: job.leaseId, maxRows: 100, shouldContinue: () => (services.now?.() ?? Date.now()) - started < 360000 });
    if (result?.complete === false) {
      await queueContinuation(db, job, services);
      return { queued: true };
    }
    if (result?.complete !== true) throw new HttpsError("failed-precondition", "The complete proposal state could not be verified.");
    await authorize(db, actorRequest(job), hotelUid, "create", undefined, services);
    const finished = await finishJob(db, job, "review", null, { counts: result.counts, totalRows: result.totalRows, summary: result.summary ?? null, warnings });
    return publicJob(finished);
  } catch (error) {
    const latest = await jobRef.get();
    if (!latest.exists || latest.data().status === "response_unknown") return latest.exists ? publicJob(latest.data()) : { ignored: true };
    if (latest.data().currentAttemptId) {
      await markUnknown(db, latest.data(), latest.data().currentAttemptId);
      return publicJob((await jobRef.get()).data());
    }
    // Retain settled costs and any successfully completed chunk receipts; never regenerate them implicitly.
    const extractionFailure = error.name === "SupplierAiExtractionError";
    const code = extractionFailure ? /LIMIT|LARGE|EXPANSION|TIMEOUT/.test(error.code) ? "resource-exhausted" : "invalid-argument"
      : ["permission-denied", "resource-exhausted", "failed-precondition", "invalid-argument"].includes(error.code) ? error.code : "processing-failed";
    const message = code === "processing-failed" ? "The supplier import could not be prepared. No automatic paid retry was made." : error.message;
    const failed = await finishJob(db, job || latest.data(), "failed", { code, message });
    return failed ? publicJob(failed) : { ignored: true };
  }
}
async function supplierProductAiImportHandler(req, res, services = {}) {
  res.set("Cache-Control", "private, no-store"); res.set("X-Content-Type-Options", "nosniff");
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: { code: "invalid-argument", message: "Use GET or POST." } });
  try {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !/^Bearer \S+$/.test(header)) throw new HttpsError("unauthenticated", "Sign in to use supplier import.");
    let token;
    try { token = await (services.auth || admin.auth()).verifyIdToken(header.slice(7), true); } catch { throw new HttpsError("unauthenticated", "Your session expired. Sign in again."); }
    const request = { auth: { uid: token.uid, token } };
    if (req.method === "POST") {
      if (req.headers["content-type"] !== "application/octet-stream") throw new HttpsError("invalid-argument", "Use a binary file upload.");
      return res.status(202).json(await uploadSupplierAiImport(request, req.query, req.rawBody, services));
    }
    return res.status(200).json(await readSupplierAiImport(request, req.query, services));
  } catch (error) {
    const status = HTTP_STATUS[error.code] || 500;
    return res.status(status).json({ error: publicImportError(status === 500 ? { code: "internal" } : error) });
  }
}
async function processSupplierAiImportJobHandler(event, services = {}) {
  const data = event.data?.data?.();
  if (!data || data.hotelUid !== event.params?.hotelUid || typeof data.jobId !== "string") return { ignored: true };
  return runSupplierAiImportJob(data.hotelUid, data.jobId, services);
}
async function cleanupSupplierAiSourcesHandler(_event, services = {}) {
  const db = services.firestore || admin.firestore(), bucket = services.bucket || admin.storage().bucket(), now = services.now?.() ?? Date.now();
  // Bounded hotel pages with a durable cursor prevent cleaned receipts from starving later tenants.
  // Every receipt/job query uses an ordinary collection and a single indexed range field.
  const cursorRef = db.doc("platformConfiguration/aiSupplierImportMaintenance"), cursor = await cursorRef.get();
  let hotelQuery = db.collection("hotels").orderBy(admin.firestore.FieldPath.documentId());
  if (cursor.data()?.afterHotelUid) hotelQuery = hotelQuery.startAfter(cursor.data().afterHotelUid);
  const hotels = await hotelQuery.limit(25).get();
  let deleted = 0, checked = 0, recovered = 0;
  for (const hotel of hotels.docs) {
    const hotelUid = strictId(hotel.id, "hotelUid"), expiry = admin.firestore.Timestamp.fromMillis(now);
    const stalled = await db.collection(`hotels/${hotelUid}/supplierAiImportJobs`).where("recoverAfter", "<=", expiry).limit(10).get();
    for (const job of stalled.docs) {
      if (job.data().hotelUid !== hotelUid || job.ref.path !== `hotels/${hotelUid}/supplierAiImportJobs/${job.data().jobId}`) continue;
      await settleExpiredAttempt(db, job.data(), services); recovered++;
    }
    const pending = await db.collection(`hotels/${hotelUid}/supplierAiImportRequests`).where("pendingUntil", "<=", expiry).limit(10).get();
    for (const receipt of pending.docs) {
      const data = receipt.data(), refs = references(db, hotelUid, strictId(data.jobId, "jobId"), data.month, receipt.id);
      if (data.hotelUid !== hotelUid || data.requestId !== receipt.id) continue;
      await db.runTransaction(async (tx) => {
        const [current, job, month, state] = await Promise.all([tx.get(receipt.ref), tx.get(refs.job), tx.get(refs.month), tx.get(refs.state)]);
        if (!current.exists || !current.data().pendingUntil || current.data().pendingUntil.toMillis() > now) return;
        if (!job.exists && !current.data().quotaReleased) {
          const usage = normalizeMonth(month, data.month), active = activeState(state);
          tx.set(refs.month, { ...usage, activeJobs: Math.max(0, usage.activeJobs - 1), updatedAt: stamp() });
          tx.set(refs.state, { ...active, activeJobs: Math.max(0, active.activeJobs - 1), updatedAt: stamp() });
        }
        tx.update(receipt.ref, { pendingUntil: admin.firestore.FieldValue.delete(), ...(!job.exists ? { quotaReleased: true } : {}) });
      }); recovered++;
    }
    if (checked >= 20) continue;
    const expired = await db.collection(`hotels/${hotelUid}/supplierAiImportRequests`).where("expiresAt", "<=", expiry).limit(Math.min(2, 20 - checked)).get();
    for (const receipt of expired.docs) {
    checked++;
    const data = receipt.data(), hotelUid = strictId(data.hotelUid, "hotelUid"), jobId = strictId(data.jobId, "jobId");
    if (receipt.ref.path !== `hotels/${hotelUid}/supplierAiImportRequests/${data.requestId}` || data.expiresAtMillis > now) continue;
    const sourcePrefix = `${prefix}/${hotelUid}/${jobId}/`, [files] = await bucket.getFiles({ prefix: sourcePrefix, maxResults: 40, autoPaginate: false });
    let blocked = false;
    for (const file of files) {
      const [metadata] = await file.getMetadata();
      if (metadata.metadata?.policyVersion !== String(AI_POLICY_VERSION) || metadata.metadata?.firebaseStorageDownloadTokens) { blocked = true; continue; }
      await file.delete({ ifGenerationMatch: validGeneration(metadata.generation), ignoreNotFound: true }); deleted++;
    }
    if (blocked || files.length >= 40) {
      await receipt.ref.set({ cleanupIssue: "unexpected-source-object", expiresAt: admin.firestore.Timestamp.fromMillis(now + 86400000) }, { merge: true });
      logger.error("Supplier AI source cleanup needs operator review.", { hotelUid, jobId, code: "unexpected-source-object" });
      continue;
    }
    const jobRef = db.doc(`hotels/${hotelUid}/supplierAiImportJobs/${jobId}`);
    const deletePrivateRows = async (path) => {
      let rows;
      do {
        rows = await db.collection(path).limit(200).get();
        if (rows.docs.length) {
          const batch = db.batch();
          for (const row of rows.docs) batch.delete(row.ref);
          await batch.commit();
        }
      } while (rows.docs.length === 200);
    };
    await deletePrivateRows(`${jobRef.path}/rows`);
    await deletePrivateRows(`${jobRef.path}/reviewIndex`);
    // Operation parents retain only command fences and aggregate decisions.
    // Their per-row children contain the source/product review snapshots and
    // expire with the source. A persistent cursor bounds cleanup per run while
    // keeping the request pending until every private snapshot was removed.
    let reviewOperations = db.collection(`${jobRef.path}/reviewOperations`).orderBy(admin.firestore.FieldPath.documentId());
    if (typeof data.cleanupReviewAfter === "string") reviewOperations = reviewOperations.startAfter(data.cleanupReviewAfter);
    const operations = await reviewOperations.limit(50).get();
    for (const operation of operations.docs) await deletePrivateRows(`${operation.ref.path}/rows`);
    if (operations.docs.length === 50) {
      await receipt.ref.set({ cleanupReviewAfter: operations.docs.at(-1).id }, { merge: true });
      continue;
    }
    await db.runTransaction(async (tx) => {
      const stateRef = db.doc(`hotels/${hotelUid}/aiImportAdministration/state`);
      const [stored, job, month, state] = await Promise.all([tx.get(receipt.ref), tx.get(jobRef), tx.get(db.doc(`hotels/${hotelUid}/aiUsageMonths/${data.month}`)), tx.get(stateRef)]);
      if (!stored.exists || stored.data().cleanupPending !== true) return;
      const usage = normalizeMonth(month, data.month);
      const release = job.exists ? !job.data().quotaReleased : !stored.data().quotaReleased;
      if (release) {
        tx.set(db.doc(`hotels/${hotelUid}/aiUsageMonths/${data.month}`), { ...usage, activeJobs: Math.max(0, usage.activeJobs - 1), importsFailed: usage.importsFailed + 1, updatedAt: stamp() });
        const active = activeState(state);
        tx.set(stateRef, { ...active, activeJobs: Math.max(0, active.activeJobs - 1), updatedAt: stamp() });
      }
      if (job.exists) tx.update(jobRef, { source: admin.firestore.FieldValue.delete(), fileName: "Expired source",
        warnings: admin.firestore.FieldValue.delete(), summary: admin.firestore.FieldValue.delete(), reconciliation: admin.firestore.FieldValue.delete(),
        sourceFormatObject: admin.firestore.FieldValue.delete(), sourceFormatCandidate: admin.firestore.FieldValue.delete(), sourceInterpretation: admin.firestore.FieldValue.delete(),
        quotaReleased: true, sourceDeletedAt: stamp(), updatedAt: stamp(),
        ...(!TERMINAL.has(job.data().status) ? { status: "failed", errorCode: "expired", errorMessage: "The import source expired. Start a new import." } : {}) });
      tx.update(receipt.ref, { cleanupPending: false, quotaReleased: true, expiresAt: admin.firestore.FieldValue.delete(),
        cleanupReviewAfter: admin.firestore.FieldValue.delete(),
        fileName: admin.firestore.FieldValue.delete(), sourceDeletedAt: stamp() });
    });
    // Do not remove the receipt: it fences replay even after the retained source has expired.
    }
  }
  await cursorRef.set({ afterHotelUid: hotels.docs.length === 25 ? hotels.docs.at(-1).id : null, updatedAt: stamp() });
  return { checked, deleted, recovered, hotels: hotels.docs.length };
}
const supplierProductAiImport = onRequest({ region: "us-central1", cors: true, memory: "512MiB", timeoutSeconds: 120, concurrency: 2, maxInstances: 3 }, supplierProductAiImportHandler);
const processSupplierProductAiImport = onDocumentCreated({ document: "hotels/{hotelUid}/supplierAiImportWork/{workId}", region: "us-central1", memory: "1GiB", timeoutSeconds: 540,
  concurrency: 1, maxInstances: 3, retry: false, secrets: [OPENAI_API_KEY] }, (event) => processSupplierAiImportJobHandler(event).catch((error) => {
  logger.error("Supplier AI import worker failed safely.", { code: typeof error.code === "string" ? error.code : "internal" });
}));
const cleanupSupplierAiSources = onSchedule({ schedule: "every 15 minutes", region: "us-central1", timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, cleanupSupplierAiSourcesHandler);
module.exports = { supplierProductAiImport, processSupplierProductAiImport, cleanupSupplierAiSources, supplierProductAiImportHandler,
  processSupplierAiImportJobHandler, cleanupSupplierAiSourcesHandler, uploadSupplierAiImport, readSupplierAiImport, runSupplierAiImportJob,
  publicJob, publicImportError, parseImportSettings, validateImportSettings, normalizeMonth, settleExpiredAttempt, savePrivate, readPrivate, REVIEW_WORKSPACE_VERSION };
