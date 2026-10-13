const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_AI_CONFIGURATION, normalizeSupplierAiConfiguration, inputReservationTokens, costMicros, normalizedProviderUsage, boundedResponseText } = require("./supplierAiPolicy");
test("AI supplier configuration defaults disabled, one cheap model, and cannot enable fallback or silently change pricing", () => {
  assert.deepEqual(normalizeSupplierAiConfiguration({}), DEFAULT_AI_CONFIGURATION);
  for (const patch of [{ fallbackEnabled: true }, { fallbackModel: "gpt-6.1-sol" }, { model: "gpt-6-astra" }, { maxCostPerImportUsd: 1 },
    { enabled: "false" }, { maxInputTokens: 300000 }, { maxOutputTokens: 0 }, { reasoningEffort: "ultra" }, { secret: "bad" },
    { maxConcurrentJobsPerHotel: 3 }, { maxMonthlyCostPerHotelUsd: null }]) assert.throws(() => normalizeSupplierAiConfiguration(patch), { code: "failed-precondition" });
});
test("integer microUSD reserves round up and include all output including reasoning only once", () => {
  // 100,000 input at $0.125/M = $0.0125; 50,000 output at $0.50/M = $0.025.
  assert.equal(costMicros(100000, 50000), 37500);
  assert.equal(costMicros(1, 1), 1);
  assert.equal(inputReservationTokens(1000), 1276);
  assert.throws(() => costMicros(null, 5), { code: "failed-precondition" });
  const result = normalizedProviderUsage({ model: "gpt-6-luna", usage: { input_tokens: 100000, output_tokens: 50000, total_tokens: 150000, output_tokens_details: { reasoning_tokens: 10000 } } });
  assert.equal(result.costMicros, 37500); assert.equal(result.reasoningTokens, 10000);
});
test("missing or inconsistent provider accounting remains unknown rather than fabricated as zero", () => {
  for (const response of [{}, { model: "gpt-6-luna", usage: {} }, { model: "gpt-6-astra", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } },
    { model: "gpt-6-luna", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 19 } },
    { model: "gpt-6-luna", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, output_tokens_details: { reasoning_tokens: 11 } } }]) assert.equal(normalizedProviderUsage(response), null);
});
test("truncated, refused, invalid and empty proposals never become valid partial review data", () => {
  const response = (text) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] });
  assert.deepEqual(boundedResponseText(response('{"rows":[]}')), { rows: [] });
  assert.throws(() => boundedResponseText({ ...response('{"rows":[]}'), status: "incomplete" }), /truncated/);
  assert.throws(() => boundedResponseText(response("not JSON")), /structured/);
  assert.throws(() => boundedResponseText(response("")), /empty/);
  assert.throws(() => boundedResponseText({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }), /complete/);
});
