const assert = require("node:assert/strict");
const test = require("node:test");

const { getDescriptionUpdates } = require("./arrivals");

function record(id, data) {
  return { id, ref: { id }, data: () => data };
}

test("getDescriptionUpdates only updates changed descriptions", () => {
  const unchanged = record("1", { rateCode: "BAR", description: "Best available" });
  const missing = record("2", { rateCode: " CORP " });
  const stale = record("3", { rateCode: "OLD", description: "Old description" });

  const updates = getDescriptionUpdates(
    [unchanged, missing, stale],
    { BAR: "Best available", CORP: "Corporate" }
  );

  assert.deepEqual(updates, [
    { record: missing, description: "Corporate" },
    { record: stale, description: "" },
  ]);
});
