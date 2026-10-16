const { HttpsError } = require("firebase-functions/v2/https");
const { authorityAllows } = require("./purchaseRequestPolicy");

// A substitute or higher authority performs the original control. It never
// removes another required control or permits one person to approve twice.
function assignmentAuthority(settings, uid, stepId, amount, costCentreId) {
  const authority = settings.approvers?.find((person) => person.uid === uid);
  if (!authority || !Number.isSafeInteger(authority.limitMinor) || authority.limitMinor < amount) return null;
  if (stepId === "over-budget") return authority.canApproveOverBudget === true ? { kind: "standard", authorityStepId: stepId } : null;
  const step = settings.approvalSteps?.find((item) => item.id === stepId);
  if (!step) return null;
  const centre = stepId === settings.approvalSteps[0]?.id ? settings.costCentres?.find((item) => item.id === costCentreId) : null;
  const inDepartment = !centre || !Object.hasOwn(centre, "approverUids") || centre.approverUids.includes(uid);
  if (inDepartment && authorityAllows(authority, stepId, amount)) return { kind: "standard", authorityStepId: stepId };
  if (step.substituteUids?.includes(uid) || centre?.substituteUids?.includes(uid)) return { kind: "substitute", authorityStepId: stepId };
  if (step.fallbackStepId && authorityAllows(authority, step.fallbackStepId, amount)) return { kind: "higher-level", authorityStepId: step.fallbackStepId };
  return null;
}

// Bounded bipartite matching (at most nine controls, 100 people). Greedy
// assignment can consume the only person eligible for a later control.
function canComplete(candidateLists, excluded = new Set()) {
  const owners = new Map();
  const assign = (index, seen) => {
    for (const candidate of candidateLists[index]) {
      if (excluded.has(candidate.uid) || seen.has(candidate.uid)) continue;
      seen.add(candidate.uid);
      if (!owners.has(candidate.uid) || assign(owners.get(candidate.uid), seen)) {
        owners.set(candidate.uid, index); return true;
      }
    }
    return false;
  };
  return candidateLists.every((_, index) => assign(index, new Set()));
}
function viableCandidates(candidateLists) {
  return candidateLists.map((candidates, index) => candidates.filter((candidate) => canComplete(candidateLists.filter((_, other) => other !== index), new Set([candidate.uid]))));
}
function selectAssignee(route, requestedUid) {
  const candidates = route.plan[0]?.candidates || [];
  const uid = requestedUid || (candidates.length === 1 ? candidates[0].uid : null);
  if (!uid) throw new HttpsError("failed-precondition", "Choose an authorized approver. Several people can complete this route.");
  const person = candidates.find((candidate) => candidate.uid === uid);
  if (!person) throw new HttpsError("permission-denied", "This approver cannot complete the required route with independent, authorized people. Refresh the approval route.");
  return person;
}
module.exports = { assignmentAuthority, canComplete, viableCandidates, selectAssignee };
