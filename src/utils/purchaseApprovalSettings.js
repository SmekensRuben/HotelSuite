// Draft diagnostics complement the authoritative route check for each saved
// request. They do not grant authority or make an incomplete configuration safe.
export function purchaseApprovalWarnings(settings, users = []) {
  const warnings = [], steps = settings?.approvalSteps || [], people = settings?.approvers || [];
  const eligible = (uid) => users.some((user) => user.uid === uid && user.eligible !== false);
  if (!steps.length) warnings.push("Add an approval step before requests can be submitted.");
  if (steps[0] && Number(steps[0].threshold) !== 0) warnings.push("Set the first step's Required from to 0.00 so every department has an initial approval control.");
  for (const centre of settings?.costCentres || []) {
    if (!Object.hasOwn(centre, "approverUids")) warnings.push(`${centre.name || "Unnamed cost centre"} uses all first-step approvers. Assign its department approvers to restrict routing.`);
    else if (!centre.approverUids.some((uid) => eligible(uid) && people.some((person) => person.uid === uid && person.stepIds.includes(steps[0]?.id))) && !centre.substituteUids?.some(eligible)) warnings.push(`${centre.name || "Unnamed cost centre"} has no eligible department approver or substitute. Review the first-step authority and request limits.`);
  }
  for (const [index, step] of steps.entries()) {
    if (step.fallbackStepId && !steps.slice(index + 1).some((other) => other.id === step.fallbackStepId)) warnings.push(`${step.name || "Unnamed step"} must use a later step as its higher approval level. Review this setting after reordering steps.`);
    const threshold = Number(step.threshold), ids = new Set([...people.filter((person) => person.stepIds.includes(step.id)).map((person) => person.uid), ...(step.substituteUids || []), ...people.filter((person) => step.fallbackStepId && person.stepIds.includes(step.fallbackStepId)).map((person) => person.uid)]);
    if (![...ids].some((uid) => eligible(uid) && Number(people.find((person) => person.uid === uid)?.limit) >= threshold)) warnings.push(`${step.name || "Unnamed step"} has no eligible authority whose Request limit reaches its Required from amount.`);
  }
  for (const person of people) if (person.selfApprovalEnabled && !users.some((user) => user.uid === person.uid && user.selfApprovalEligible === true)) warnings.push(`${users.find((user) => user.uid === person.uid)?.name || person.uid} needs the separate Purchase Requests Self-approve permission before a self-approval limit can be saved.`);
  if (settings?.overBudgetMode === "approval" && !people.some((person) => person.canApproveOverBudget && eligible(person.uid))) warnings.push("Over-budget requests need an independent person with additional budget authority.");
  if (steps.length > new Set(people.filter((person) => eligible(person.uid)).map((person) => person.uid)).size) warnings.push("There are fewer eligible people than configured steps. Requests reaching all thresholds may be blocked because each required control needs a different person.");
  return warnings;
}
