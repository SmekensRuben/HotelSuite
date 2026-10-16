const test = require("node:test");
const assert = require("node:assert/strict");
const { canComplete, viableCandidates } = require("./purchaseApprovalRouting");
const policy = require("./purchaseRequestPolicy");
const people = (...uids) => uids.map((uid) => ({ uid }));

test("matching preserves a later unique authority and rejects shared bottlenecks", () => {
  assert.equal(canComplete([people("a", "b"), people("a")]), true);
  assert.deepEqual(viableCandidates([people("a", "b"), people("a")]), [people("b"), people("a")]);
  assert.equal(canComplete([people("a", "b"), people("a", "b"), people("a", "b")]), false);
  assert.equal(canComplete([people("a")], new Set(["a"])), false);
  assert.equal(canComplete([]), true);
});
test("bounded matching agrees with exhaustive distinct-person assignment across small candidate graphs", () => {
  const brute = (lists, used = []) => !lists.length || lists[0].some(({ uid }) => !used.includes(uid) && brute(lists.slice(1), [...used, uid]));
  for (let mask = 0; mask < 512; mask++) {
    const lists = [0, 1, 2].map((index) => ["a", "b", "c"].filter((_, bit) => mask & 1 << (index * 3 + bit)).map((uid) => ({ uid })));
    assert.equal(canComplete(lists), brute(lists), String(mask));
    for (const [index, candidates] of viableCandidates(lists).entries()) for (const { uid } of candidates) assert.ok(brute(lists.filter((_, other) => other !== index), [uid]));
  }
});
test("settings validate stable routing references, explicit independent controls and separate self limits", () => {
  const input = { ...policy.DEFAULT_SETTINGS, costCentres: [{ id: "kitchen", name: "Kitchen", approverUids: ["head"], substituteUids: ["gm"] }],
    approvalSteps: [{ id: "head", name: "Department", thresholdMinor: 0, substituteUids: ["gm"], fallbackStepId: "gm" }, { id: "gm", name: "GM", thresholdMinor: 10000, independentRequired: true }],
    approvers: [{ uid: "head", stepIds: ["head"], limitMinor: 10000, canApproveOverBudget: false }, { uid: "gm", stepIds: ["gm"], limitMinor: 50000, canApproveOverBudget: true, selfApprovalLimitMinor: 20000 }] };
  assert.deepEqual(policy.normalizeSettings(input), input);
  const invalid = [
    { ...input, costCentres: [{ ...input.costCentres[0], substituteUids: ["foreign"] }] },
    { ...input, approvalSteps: input.approvalSteps.map((step) => ({ ...step, fallbackStepId: "head" })) },
    { ...input, approvalSteps: [{ ...input.approvalSteps[0], thresholdMinor: 100 }, input.approvalSteps[1]] },
    { ...input, approvalSteps: [{ ...input.approvalSteps[0], independentRequired: "yes" }, input.approvalSteps[1]] },
    { ...input, approvers: input.approvers.map((person) => ({ ...person, selfApprovalLimitMinor: -1 })) },
  ];
  for (const settings of invalid) assert.throws(() => policy.normalizeSettings(settings), { code: "invalid-argument" });
});
