import React from "react";
import { purchaseRequestTime } from "../../utils/purchaseRequests";

export function assignmentLabel(person) {
  const name = person.name || person.approverName || person.uid || person.approverUid;
  return `${name}${person.kind === "substitute" ? " · Designated substitute" : person.kind === "higher-level" ? " · Higher approval level" : ""}`;
}
export function PurchaseApprovalRoute({ route }) {
  if (!route?.plan?.length || route.error) return null;
  return <div className="mt-3 space-y-2 rounded-lg border border-blue-100 bg-blue-50/50 p-3">
    <p className="text-sm font-medium">Full route checked</p>
    <p className="text-xs text-stone-600">Each control needs a different person. Choices below preserve a complete route. Access and limits are checked again at each decision.</p>
    <ol className="space-y-2">{route.plan.map((step, index) => <li key={step.id} className="text-sm"><span className="font-medium">{index + 1}. {step.name}</span>{step.candidates.length <= 3 ? <p className="mt-1 text-xs text-stone-600">{step.candidates.length === 1 ? "Automatic assignment when this step starts: " : "Choose when this step starts: "}{step.candidates.map(assignmentLabel).join("; ")}</p> : <details className="mt-1 text-xs text-stone-600"><summary className="min-h-[36px] cursor-pointer py-2">{step.candidates.length} eligible people · Choose when this step starts</summary><p className="mt-1 leading-6">{step.candidates.map(assignmentLabel).join("; ")}</p></details>}</li>)}</ol>
  </div>;
}
export function SelfApprovalNote({ approval }) {
  if (!approval) return null;
  return <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-950"><p className="font-medium">Self-approved by {approval.approverName || approval.approverUid}</p><p className="mt-1">{purchaseRequestTime(approval.approvedAtMillis)} · {approval.reason}</p>{approval.coveredSteps?.length > 0 && <p className="mt-2 text-xs">Covered controls: {approval.coveredSteps.map((step) => step.name).join(", ")}. Any required independent controls are recorded separately.</p>}</div>;
}
