import React from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: { currentUser: { uid: "requester" } }, hotel: "hotel-a", permissions: [], context: vi.fn(), list: vi.fn(), detail: vi.fn(), mutate: vi.fn(), pending: vi.fn(), recover: vi.fn(), upload: vi.fn(), download: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, permissions: mocks.permissions }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.permissions.includes(`${feature}.${action}`) }));
vi.mock("../layout/PageShell", () => ({ default: ({ children }) => <main>{children}</main> }));
vi.mock("../../services/firebasePurchaseRequests", () => ({ getPurchaseRequestContext: mocks.context, listPurchaseRequests: mocks.list, getPurchaseRequest: mocks.detail, mutatePurchaseRequest: mocks.mutate, getPendingPurchaseRequestCommand: mocks.pending, retryPurchaseRequestCommand: mocks.recover }));
vi.mock("../../services/firebasePurchaseRequestAttachments", () => ({ uploadPurchaseRequestAttachment: mocks.upload, downloadPurchaseRequestAttachment: mocks.download, PURCHASE_REQUEST_ATTACHMENT_ACCEPT: ".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.txt,.csv" }));
vi.mock("../purchasing/PurchaseRequestNotifications", () => ({ default: () => <section aria-label="Email notifications" /> }));
import PurchaseRequestsPage from "./PurchaseRequestsPage";
import PurchaseRequestFormPage from "./PurchaseRequestFormPage";
import PurchaseRequestDetailPage from "./PurchaseRequestDetailPage";

let request, context, budget, history, submissionApprovalRoute, selfApprovalRoute, decisionApprovalRoute, recoveryApprovalRoute;
const routeFingerprint = "a".repeat(64);
const firstStepEscalation = { reason: "requester-only-first-step", fromStepId: "manager", fromStepName: "Department manager", toStepId: "finance", toStepName: "Finance", settingsRevision: 4 };
const escalatedSubmissionRoute = () => ({ steps: [{ id: "finance", name: "Finance" }], approvers: [{ uid: "finance", name: "Robin Finance" }], escalation: firstStepEscalation, error: null, fingerprint: routeFingerprint });
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname}</output>; }
function tree(path = "/purchase-requests/request-a") { return <MemoryRouter initialEntries={[path]}><Location /><Routes><Route path="/purchase-requests" element={<PurchaseRequestsPage />} /><Route path="/purchase-requests/new" element={<PurchaseRequestFormPage />} /><Route path="/purchase-requests/:purchaseRequestId" element={<PurchaseRequestDetailPage />} /><Route path="/purchase-requests/:purchaseRequestId/edit" element={<PurchaseRequestFormPage />} /></Routes></MemoryRouter>; }
const checkedRoute = (steps = [], candidates = []) => ({ steps, approvers: candidates.map(({ uid, name }) => ({ uid, name })), plan: steps.map((step) => ({ ...step, candidates })), error: null, escalation: null, fingerprint: routeFingerprint });

function enableRecovery(status = "pending") {
  mocks.auth.currentUser = { uid: "administrator" };
  mocks.permissions = ["purchaserequests.read", "purchaserequests.recover"];
  Object.assign(request, { status, currentApproverUid: status === "pending" ? "manager" : null, currentApproverName: status === "pending" ? "Alex Manager" : null, approvalSteps: [{ id: "manager", name: "Department manager" }], reservation: { state: "pending", amountMinor: 15000 } });
  recoveryApprovalRoute = checkedRoute(request.approvalSteps, [{ uid: "substitute", name: "Dana Substitute", kind: "substitute" }]);
}
it("reassigns only through the verified recovery route and requires an explanation", async () => {
  enableRecovery();
  render(tree()); fireEvent.click(await screen.findByRole("button", { name: "Reassign approver" }));
  const dialog = await screen.findByRole("dialog", { name: "Reassign approver" });
  expect(dialog).toHaveTextContent("Currently assigned to Alex Manager");
  expect(dialog).toHaveTextContent("Designated substitute");
  expect(within(dialog).getByLabelText("Replacement approver · Department manager")).toHaveValue("substitute");
  expect(within(dialog).queryByRole("option", { name: "Alex Manager" })).not.toBeInTheDocument();
  const confirm = within(dialog).getByRole("button", { name: "Confirm reassignment" });
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText("Decision note (required)"), { target: { value: "   " } });
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText("Decision note (required)"), { target: { value: "  Current approver is on leave  " } });
  fireEvent.click(confirm);
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", { purchaseRequestId: "request-a", expectedRevision: 2, action: "reassign", approverUid: "substitute", reason: "Current approver is on leave", expectedApprovalRouteFingerprint: routeFingerprint }));
});
it("retains a real replacement choice when several authorized people can complete the route", async () => {
  enableRecovery();
  recoveryApprovalRoute = checkedRoute(request.approvalSteps, [{ uid: "substitute", name: "Dana Substitute" }, { uid: "finance", name: "Robin Finance" }]);
  render(tree()); fireEvent.click(await screen.findByRole("button", { name: "Reassign approver" }));
  const dialog = await screen.findByRole("dialog", { name: "Reassign approver" });
  expect(within(dialog).getByLabelText("Replacement approver · Department manager")).toHaveValue("");
  fireEvent.change(within(dialog).getByLabelText("Decision note (required)"), { target: { value: "Cover planned absence" } });
  const confirm = within(dialog).getByRole("button", { name: "Confirm reassignment" }); expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText("Replacement approver · Department manager"), { target: { value: "finance" } });
  fireEvent.click(confirm);
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ action: "reassign", approverUid: "finance" })));
});
it.each(["pending", "returned"])("requires a recovery cancellation reason for a %s request without owner privileges", async (status) => {
  enableRecovery(status);
  render(tree()); fireEvent.click(await screen.findByRole("button", { name: "Cancel for recovery" }));
  const dialog = await screen.findByRole("dialog", { name: "Cancel for recovery" });
  expect(dialog).toHaveTextContent("release its held budget reservation");
  expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
  const confirm = within(dialog).getByRole("button", { name: "Confirm recovery cancellation" }); expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText("Decision note (required)"), { target: { value: "The original requester has left the hotel" } });
  fireEvent.click(confirm);
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", { purchaseRequestId: "request-a", expectedRevision: 2, action: "recovercancel", reason: "The original requester has left the hotel" }));
});
it("keeps recovery cancellation available when the remaining approval route is blocked", async () => {
  enableRecovery(); recoveryApprovalRoute = { ...checkedRoute(), error: { message: "No independent budget authority remains." }, fingerprint: null };
  render(tree()); expect(await screen.findByRole("button", { name: "Reassign approver" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel for recovery" })).toBeEnabled();
  expect(screen.getByRole("region", { name: "Exception recovery" })).toHaveTextContent("No independent budget authority remains.");
  expect(mocks.mutate).not.toHaveBeenCalled();
});
it("requires an authoritative recovery route instead of falling back to general approver settings", async () => {
  enableRecovery(); recoveryApprovalRoute = undefined;
  render(tree()); expect(await screen.findByRole("button", { name: "Reassign approver" })).toBeDisabled();
  expect(screen.getByText("The recovery approval route could not be verified. Refresh the request before reassigning.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel for recovery" })).toBeEnabled();
});
it("blocks a no-op reassignment and never selects the requester or a completed approver", async () => {
  enableRecovery(); request.approvals = [{ approverUid: "finance", stepId: "finance" }];
  recoveryApprovalRoute = checkedRoute(request.approvalSteps, [{ uid: "manager", name: "Alex Manager" }, { uid: "requester", name: "Sam Requester" }, { uid: "finance", name: "Robin Finance" }]);
  render(tree()); expect(await screen.findByRole("button", { name: "Reassign approver" })).toBeDisabled();
  expect(screen.getByText("No different eligible approver can complete the required route. Review the approval settings or cancel this request with a recovery reason.")).toBeInTheDocument();
});
it("ordinary decision and cancellation permissions do not expose recovery actions", async () => {
  request.status = "pending"; request.currentApproverUid = "manager";
  recoveryApprovalRoute = checkedRoute([{ id: "manager", name: "Department manager" }], [{ uid: "substitute", name: "Dana Substitute" }]);
  render(tree()); await screen.findByRole("heading", { name: "Replacement plates" });
  expect(screen.queryByRole("button", { name: "Reassign approver" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Cancel for recovery" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Exception recovery" })).not.toBeInTheDocument();
});
it.each(["draft", "approved", "rejected", "canceled", "withdrawn"])("does not expose exception recovery on a %s request", async (status) => {
  enableRecovery(status); render(tree()); await screen.findByRole("heading", { name: "Replacement plates" });
  expect(screen.queryByRole("button", { name: "Reassign approver" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Cancel for recovery" })).not.toBeInTheDocument();
});
it("shows returned request ownership and only permits recovery cancellation", async () => {
  enableRecovery("returned"); render(tree()); await screen.findByRole("heading", { name: "Replacement plates" });
  expect(screen.getByRole("region", { name: "Approval progress" })).toHaveTextContent("Responsible for changes: Sam Requester");
  expect(screen.queryByRole("button", { name: "Reassign approver" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel for recovery" })).toBeEnabled();
});
it("preserves original-command recovery before permitting administrative recovery actions", async () => {
  enableRecovery(); mocks.pending.mockReturnValue({ requestId: "original", input: { action: "reassign", approverUid: "substitute" } });
  mocks.recover.mockImplementation(async () => { mocks.pending.mockReturnValue(null); return { request, budget }; });
  render(tree()); expect(await screen.findByRole("button", { name: "Reassign approver" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel for recovery" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Recover original action" }));
  await waitFor(() => expect(mocks.recover).toHaveBeenCalledWith("hotel-a", "request-a"));
  expect(mocks.mutate).not.toHaveBeenCalled();
});
it("shows original assignment, responsible replacement and recovery reason in immutable history", async () => {
  enableRecovery();
  const original = structuredClone(request);
  request.currentApproverUid = "substitute"; request.currentApproverName = "Dana Substitute"; request.revision = 3;
  request.lastRecovery = { action: "reassign", actorUid: "administrator", actorName: "Lee Administrator", reason: "Current approver is on leave", recoveredAtMillis: 1792051200000, stepId: "manager", stepName: "Department manager", fromApproverUid: "manager", fromApproverName: "Alex Manager", toApproverUid: "substitute", toApproverName: "Dana Substitute", settingsRevision: 4 };
  history = [{ revision: 2, event: "submit", actorName: "Sam Requester", snapshot: original }, { revision: 3, event: "reassign", actorName: "Lee Administrator", snapshot: structuredClone(request) }];
  render(tree()); await screen.findByRole("heading", { name: "Replacement plates" });
  expect(screen.getByRole("region", { name: "Approval progress" })).toHaveTextContent("Current responsibility: Department manager · Dana Substitute");
  const timeline = screen.getByRole("region", { name: "Request timeline" });
  expect(timeline).toHaveTextContent("Originally assigned to Alex Manager");
  expect(timeline).toHaveTextContent("Approver reassigned · Version 3");
  expect(timeline).toHaveTextContent("Department manager: Alex Manager → Dana Substitute");
  expect(timeline).toHaveTextContent("Current approver is on leave");
  expect(timeline).toHaveTextContent("Lee Administrator");
});

it("uses server-filtered full-route candidates and keeps a real choice when several people remain", async () => {
  submissionApprovalRoute = checkedRoute([{ id: "manager", name: "Department manager" }], [{ uid: "manager", name: "Alex Manager", kind: "standard" }, { uid: "finance", name: "Robin Finance", kind: "substitute" }]);
  render(tree()); fireEvent.click(await screen.findByRole("button", { name: "Submit request" }));
  const dialog = await screen.findByRole("dialog", { name: "Submit request" });
  expect(dialog).toHaveTextContent("Full route checked"); expect(dialog).toHaveTextContent("Designated substitute");
  expect(within(dialog).getByLabelText("First approver · Department manager")).toHaveValue("");
  expect(within(dialog).getByRole("button", { name: "Confirm submit" })).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText("First approver · Department manager"), { target: { value: "finance" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm submit" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ approverUid: "finance", expectedApprovalRouteFingerprint: routeFingerprint })));
});
it("requires a reason and a verified dedicated route before direct self-approved registration", async () => {
  mocks.permissions.push("purchaserequests.selfapprove"); selfApprovalRoute = checkedRoute();
  render(tree()); fireEvent.click(await screen.findByRole("button", { name: "Approve & register" }));
  const dialog = await screen.findByRole("dialog", { name: "Approve & register" });
  expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
  expect(dialog).toHaveTextContent("will become an approved commitment");
  const confirm = within(dialog).getByRole("button", { name: "Confirm approve & register" }); expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText("Decision note (required)"), { target: { value: "Replacement within my delegated GM authority" } });
  fireEvent.click(confirm);
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", { purchaseRequestId: "request-a", expectedRevision: 2, action: "selfapprove", reason: "Replacement within my delegated GM authority", expectedApprovalRouteFingerprint: routeFingerprint }));
});
it("retains independent controls after self-approval and automatically selects the sole independent person", async () => {
  mocks.permissions.push("purchaserequests.selfapprove"); selfApprovalRoute = checkedRoute([{ id: "finance", name: "Independent Finance" }], [{ uid: "finance", name: "Robin Finance", kind: "standard" }]);
  render(tree()); fireEvent.click(await screen.findByRole("button", { name: "Approve & register" }));
  const dialog = await screen.findByRole("dialog", { name: "Approve & register" });
  expect(within(dialog).getByLabelText("First approver · Independent Finance")).toHaveValue("finance");
  expect(dialog).toHaveTextContent("will be reserved");
  fireEvent.change(within(dialog).getByLabelText("Decision note (required)"), { target: { value: "GM review; independent Finance required" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm approve & register" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ action: "selfapprove", approverUid: "finance", expectedApprovalRouteFingerprint: routeFingerprint })));
});
it("ordinary approve permission does not expose direct self-approval", async () => {
  selfApprovalRoute = checkedRoute(); render(tree()); await screen.findByRole("heading", { name: "Replacement plates" });
  expect(screen.queryByRole("button", { name: "Approve & register" })).not.toBeInTheDocument();
});
it("shows a failed self-approval limit or budget check and blocks the direct command", async () => {
  mocks.permissions.push("purchaserequests.selfapprove"); selfApprovalRoute = { ...checkedRoute(), error: { message: "The full request exceeds your self-approval limit." }, fingerprint: null };
  render(tree()); expect(await screen.findByRole("button", { name: "Approve & register" })).toBeDisabled();
  expect(screen.getByText("The full request exceeds your self-approval limit.")).toBeInTheDocument(); expect(mocks.mutate).not.toHaveBeenCalled();
});
it("uses authoritative remaining candidates for substitutes and includes the decision fingerprint", async () => {
  mocks.auth.currentUser = { uid: "manager" }; request.status = "pending"; request.currentApproverUid = "manager";
  request.approvalSteps = [{ id: "manager", name: "Department" }, { id: "finance", name: "Finance" }];
  decisionApprovalRoute = checkedRoute([{ id: "finance", name: "Finance" }], [{ uid: "substitute", name: "Dana Substitute", kind: "higher-level" }]);
  render(tree()); fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  const dialog = await screen.findByRole("dialog", { name: "Approve" });
  expect(within(dialog).getByLabelText("Next approver · Finance")).toHaveValue("substitute");
  expect(within(dialog).queryByRole("option", { name: "Robin Finance" })).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm approve" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ action: "approve", nextApproverUid: "substitute", expectedApprovalRouteFingerprint: routeFingerprint })));
});
it("blocks approval when a later route is unavailable without disabling return for changes", async () => {
  mocks.auth.currentUser = { uid: "manager" }; request.status = "pending"; request.currentApproverUid = "manager";
  request.approvalSteps = [{ id: "manager", name: "Department" }];
  decisionApprovalRoute = { ...checkedRoute(), error: { message: "No independent budget authority remains." }, fingerprint: null };
  render(tree()); expect(await screen.findByRole("button", { name: "Approve" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Return for changes" })).toBeEnabled();
  expect(screen.getByText("No independent budget authority remains.")).toBeInTheDocument();
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.auth.currentUser = { uid: "requester" }; mocks.permissions = ["purchaserequests.read", "purchaserequests.create", "purchaserequests.update", "purchaserequests.submit", "purchaserequests.approve", "purchaserequests.cancel", "purchasebudgets.read"];
  context = { settings: { currency: "EUR", costCentres: [{ id: "restaurant", name: "Restaurant" }], budgetCategories: [{ id: "chinaware", name: "Chinaware" }], approvalSteps: [{ id: "manager", name: "Department manager", thresholdMinor: 0 }, { id: "finance", name: "Finance", thresholdMinor: 20000 }], overBudgetMode: "block" }, suppliers: [{ id: "supplier", name: "Hotel Supplies" }], approvers: [{ uid: "requester", name: "Requester", stepIds: ["manager"], limitMinor: 100000, eligible: true }, { uid: "manager", name: "Alex Manager", stepIds: ["manager"], limitMinor: 100000, eligible: true }, { uid: "finance", name: "Robin Finance", stepIds: ["finance"], limitMinor: 100000, eligible: true }, { uid: "revoked", name: "Removed approver", stepIds: ["manager"], limitMinor: 100000, eligible: false }], supplierProducts: [] };
  budget = { exists: true, id: "2026-10__chinaware", month: "2026-10", categoryId: "chinaware", budgetMinor: 50000, openingUsedMinor: 0, pendingMinor: 0, committedMinor: 30000, remainingMinor: 20000 };
  request = { id: "request-a", hotelUid: "hotel-a", revision: 2, status: "draft", requesterUid: "requester", requesterName: "Sam Requester", currency: "EUR", supplierId: "supplier", supplier: { id: "supplier", name: "Hotel Supplies" }, title: "Replacement plates", description: "Replace damaged dinner plates", motivation: "Maintain enough plates for dinner service", costCentreId: "restaurant", costCentreName: "Restaurant", budgetCategoryId: "chinaware", budgetCategoryName: "Chinaware", budgetMonth: "2026-10", totalMinor: 15000, lines: [{ id: "line-a", kind: "free", description: "Dinner plates", quantity: 10, unitPrice: 15, unit: "each", lineTotalMinor: 15000 }], attachmentIds: [], attachments: [], approvals: [], approvalSteps: [], currentStepIndex: 0, reservation: { state: "none", amountMinor: 0 } };
  history = [{ revision: 2, event: "save", actorName: "Sam Requester", createdAtMillis: 1792051200000, snapshot: structuredClone(request) }];
  submissionApprovalRoute = undefined; selfApprovalRoute = undefined; decisionApprovalRoute = undefined; recoveryApprovalRoute = undefined;
  mocks.pending.mockReturnValue(null);
  mocks.context.mockImplementation(async (_, options = {}) => structuredClone({ ...context, ...(options.budgetMonth && options.budgetCategoryId ? { budget } : {}) }));
  mocks.detail.mockImplementation(async () => structuredClone({ request, history, budget, ...(submissionApprovalRoute === undefined ? {} : { submissionApprovalRoute }), ...(selfApprovalRoute === undefined ? {} : { selfApprovalRoute }), ...(decisionApprovalRoute === undefined ? {} : { decisionApprovalRoute }), ...(recoveryApprovalRoute === undefined ? {} : { recoveryApprovalRoute }) }));
  mocks.list.mockImplementation(async () => ({ requests: [structuredClone(request)], nextCursor: null }));
  mocks.mutate.mockImplementation(async (_, input) => {
    if (input.draft) request = { ...request, ...input.draft };
    if (input.action === "submit") request = { ...request, status: "pending", currentApproverUid: input.approverUid, currentApproverName: "Alex Manager", approvalSteps: [{ id: "manager", name: "Department manager" }], reservation: { state: "pending", amountMinor: request.totalMinor } };
    if (input.action === "return") request = { ...request, status: "returned", currentApproverUid: null, currentApproverName: null };
    if (input.action === "approve") request = input.nextApproverUid ? { ...request, currentStepIndex: request.currentStepIndex + 1, currentApproverUid: input.nextApproverUid } : { ...request, status: "approved", reservation: { ...request.reservation, state: "committed" } };
    request.revision += 1;
    return { hotelUid: "hotel-a", purchaseRequestId: request.id, request: structuredClone(request), budget: structuredClone(budget) };
  });
});
it("filters the operational list by status, fixed budget month, department and assigned approver", async () => {
  render(tree("/purchase-requests")); await screen.findByText("Replacement plates");
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "pending" } });
  fireEvent.change(screen.getByLabelText("Budget month"), { target: { value: "2026-10" } });
  await screen.findByRole("option", { name: "Restaurant" });
  fireEvent.change(screen.getByLabelText("Cost centre"), { target: { value: "restaurant" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Awaiting my approval" }));
  await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith("hotel-a", { status: "pending", month: "2026-10", costCentreId: "restaurant", awaitingMyApproval: true, cursor: null, limit: 30 }));
  expect(screen.getByRole("link", { name: "Budgets" })).toHaveAttribute("href", "/purchase-budgets");
});
it("requires an explicit month in a new draft and previews exact quoted prices before saving", async () => {
  render(tree("/purchase-requests/new")); await screen.findByLabelText("Title");
  expect(screen.getByLabelText("Budget month")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Glass repair" } });
  fireEvent.change(screen.getByLabelText("Line 1 supplier"), { target: { value: "supplier" } });
  fireEvent.change(screen.getByLabelText("Cost centre / department"), { target: { value: "restaurant" } });
  fireEvent.change(screen.getByLabelText("Budget category"), { target: { value: "chinaware" } });
  fireEvent.change(screen.getByLabelText("Budget month"), { target: { value: "2026-11" } });
  fireEvent.change(screen.getByLabelText("Line 1 description"), { target: { value: "On-site glass repair" } });
  fireEvent.change(screen.getByLabelText("Net unit price (EUR)"), { target: { value: "1.005" } });
  await screen.findByRole("region", { name: "Budget impact" });
  expect(within(screen.getByRole("region", { name: "Budget impact" })).getByText("€1.01")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ action: "create", expectedRevision: 0, draft: expect.objectContaining({ budgetMonth: "2026-11", lines: [expect.objectContaining({ kind: "free", unitPrice: "1.005", quantity: "1" })] }) })));
});
it("shows a returned request's held reservation only once when its amount changes", async () => {
  request.status = "returned"; request.reservation = { state: "pending", amountMinor: 15000, bucketId: "2026-10__chinaware" }; budget.pendingMinor = 15000; budget.remainingMinor = 5000;
  render(tree("/purchase-requests/request-a/edit")); await screen.findByDisplayValue("Replacement plates");
  fireEvent.change(screen.getByLabelText("Net unit price (EUR)"), { target: { value: "17" } });
  const impact = await screen.findByRole("region", { name: "Budget impact" });
  expect(impact).toHaveTextContent("€30.00"); expect(impact).toHaveTextContent("€170.00");
  expect(impact).not.toHaveTextContent("exceeds the available budget");
});
it("does not credit an old returned reservation to a newly selected budget month", async () => {
  request.status = "returned"; request.reservation = { state: "pending", amountMinor: 15000, bucketId: "2026-09__chinaware" }; budget.pendingMinor = 0; budget.remainingMinor = 20000;
  render(tree("/purchase-requests/request-a/edit")); await screen.findByDisplayValue("Replacement plates");
  const impact = await screen.findByRole("region", { name: "Budget impact" });
  expect(within(impact).getByText("Available after submission").parentElement).toHaveTextContent("€50.00");
});
it("keeps missing budgets distinct from configured zero and does not invent unavailable quote prices", async () => {
  budget = { exists: false }; context.supplierProducts = [{ id: "delivery-product", supplierProductName: "Delivery-date quotation", supplierSku: "D-001", pricePerPurchaseUnit: null, purchaseUnit: "box", requiresQuote: true, priceValidity: "unknown", currency: "EUR", purchaseOptions: [{ id: "case", label: "Case", purchaseUnit: "case", pricePerPurchaseUnit: null }] }];
  render(tree("/purchase-requests/request-a/edit"));
  fireEvent.click(await screen.findByRole("button", { name: "Choose supplier product" }));
  await screen.findByText("Delivery-date quotation");
  expect(await screen.findByRole("region", { name: "Budget impact" })).toHaveTextContent("No budget is configured");
  fireEvent.click(screen.getByRole("button", { name: "Use Case · Enter quoted price" }));
  expect(screen.getByLabelText("Net unit price (EUR)")).toHaveValue(null);
  expect(screen.getByText("An explicit net quotation in EUR is required.")).toBeInTheDocument();
  expect(screen.getByText(/Enter valid quantities and net unit prices/)).toBeInTheDocument();
});
it("continues through empty bounded supplier search windows to reach later matching articles", async () => {
  mocks.context.mockImplementation(async (_, options = {}) => ({ ...structuredClone(context), budget: structuredClone(budget), supplierProducts: options.cursor ? [{ id: "later", supplierProductName: "Later supplier article", supplierSku: "901", purchaseUnit: "box", pricePerPurchaseUnit: "1.005", currency: "EUR" }] : [], nextProductCursor: options.supplierId && !options.cursor ? "after-200" : null }));
  render(tree("/purchase-requests/request-a/edit"));
  fireEvent.click(await screen.findByRole("button", { name: "Choose supplier product" }));
  fireEvent.click(await screen.findByRole("button", { name: "More supplier products" }));
  await screen.findByText("Later supplier article");
  expect(mocks.context).toHaveBeenLastCalledWith("hotel-a", expect.objectContaining({ cursor: "after-200", supplierId: "supplier" }));
  expect(screen.getByRole("button", { name: "Use box · €1.005" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Use box · €1.005" }));
  expect(screen.getByLabelText("Net unit price (EUR)")).toHaveValue(1.005);
});
it("requires a separate submission confirmation and an eligible non-self first approver", async () => {
  render(tree()); await screen.findByRole("button", { name: "Submit request" });
  fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
  const dialog = await screen.findByRole("dialog", { name: "Submit request" });
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(within(dialog).queryByRole("option", { name: "Requester" })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("option", { name: "Removed approver" })).not.toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Confirm submit" })).toBeEnabled();
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "manager" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm submit" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", { purchaseRequestId: "request-a", expectedRevision: 2, action: "submit", approverUid: "manager" }));
});
it("requires the next authorized person and does not offer previous approvers for another step", async () => {
  mocks.auth.currentUser = { uid: "manager" }; request.status = "pending"; request.currentApproverUid = "manager"; request.currentApproverName = "Alex Manager"; request.approvalSteps = [{ id: "manager", name: "Department manager" }, { id: "finance", name: "Finance" }]; request.reservation = { state: "pending", amountMinor: 15000, bucketId: "2026-10__chinaware" };
  context.approvers.push({ uid: "manager", name: "Same manager", stepIds: ["finance"], limitMinor: 100000, eligible: true });
  render(tree()); fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  const dialog = await screen.findByRole("dialog", { name: "Approve" });
  expect(within(dialog).getByRole("button", { name: "Confirm approve" })).toBeEnabled();
  expect(within(dialog).queryByRole("option", { name: "Same manager" })).not.toBeInTheDocument();
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "finance" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm approve" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", { purchaseRequestId: "request-a", expectedRevision: 2, action: "approve", nextApproverUid: "finance" }));
});
it("requires a return reason and explains that the amount stays reserved", async () => {
  mocks.auth.currentUser = { uid: "manager" }; request.status = "pending"; request.currentApproverUid = "manager"; request.approvalSteps = [{ id: "manager", name: "Department manager" }]; request.reservation = { state: "pending", amountMinor: 15000, bucketId: "2026-10__chinaware" };
  render(tree()); fireEvent.click(await screen.findByRole("button", { name: "Return for changes" }));
  const dialog = await screen.findByRole("dialog", { name: "Return for changes" });
  expect(dialog).toHaveTextContent("current budget reservation stays held");
  expect(within(dialog).getByRole("button", { name: "Confirm return for changes" })).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Decision note (required)" }), { target: { value: "Please attach the second quotation" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm return for changes" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ action: "return", reason: "Please attach the second quotation" })));
});
it("recovers the original uncertain action and blocks different decisions", async () => {
  mocks.pending.mockReturnValue({ requestId: "original", input: { action: "submit", approverUid: "manager" } });
  mocks.recover.mockImplementation(async () => { mocks.pending.mockReturnValue(null); return { request: { ...request, status: "pending" }, budget }; });
  render(tree()); await screen.findByRole("region", { name: "Recover purchase request command" });
  expect(screen.getByRole("button", { name: "Submit request" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Recover original action" }));
  await waitFor(() => expect(mocks.recover).toHaveBeenCalledWith("hotel-a", "request-a"));
  expect(mocks.mutate).not.toHaveBeenCalled();
});
it("hides in-flight request data after a hotel switch or read permission revocation", async () => {
  let resolve; mocks.detail.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const view = render(tree()); await waitFor(() => expect(resolve).toBeDefined());
  mocks.hotel = "hotel-b"; mocks.permissions = [];
  view.rerender(tree()); await act(async () => resolve({ request, history, budget }));
  expect(screen.queryByText("Replacement plates")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("permission to read");
});
it("preserves the frozen version and attachment evidence in the timeline", async () => {
  request.title = "Revised plate request"; request.revision = 3;
  render(tree()); await screen.findByText("Revised plate request");
  const timeline = screen.getByRole("region", { name: "Request timeline" });
  fireEvent.click(within(timeline).getByText("View frozen version"));
  expect(timeline).toHaveTextContent("Replacement plates · €150.00 net · 2026-10");
  expect(timeline).toHaveTextContent("Dinner plates · Supplier: Hotel Supplies: 10 each × 15 EUR net = €150.00");
});
it("keeps uploaded supporting documents in the draft until the reviewed IDs are saved", async () => {
  const attachment = { fileId: "a".repeat(32), fileName: "Quote.pdf", sha256: "b".repeat(64), generation: "12", size: 20 };
  mocks.upload.mockResolvedValue({ attachment, revision: 2 });
  render(tree("/purchase-requests/request-a/edit")); await screen.findByDisplayValue("Replacement plates");
  const file = new File(["A quotation"], "Quote.pdf", { type: "application/pdf" });
  fireEvent.change(screen.getByLabelText("Add supporting document"), { target: { files: [file] } });
  await screen.findByText("Quote.pdf");
  expect(mocks.upload).toHaveBeenCalledWith("hotel-a", "request-a", file, 2);
  expect(mocks.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ draft: expect.objectContaining({ attachmentIds: [attachment.fileId] }) })));
});
it("recovers an uncertain draft creation without permitting replacement input or another create", async () => {
  mocks.pending.mockReturnValue({ requestId: "original-create", input: { action: "create", draft: { title: "Original request" } } });
  mocks.recover.mockResolvedValue({ purchaseRequestId: "request-a", request });
  render(tree("/purchase-requests/new")); await screen.findByRole("region", { name: "Recover purchase request command" });
  expect(screen.getByLabelText("Title")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Recover original action" }));
  await waitFor(() => expect(mocks.recover).toHaveBeenCalledWith("hotel-a", "create"));
  expect(mocks.mutate).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/purchase-requests/request-a"));
});
it("offers the additional budget authority when current budget conditions require a new final step", async () => {
  mocks.auth.currentUser = { uid: "manager" }; request.status = "pending"; request.currentApproverUid = "manager"; request.approvalSteps = [{ id: "manager", name: "Department manager" }]; request.reservation = { state: "pending", amountMinor: 15000, bucketId: "2026-10__chinaware" };
  budget.remainingMinor = -100; context.settings.overBudgetMode = "approval";
  context.approvers.push({ uid: "director", name: "Taylor Director", stepIds: [], limitMinor: 100000, canApproveOverBudget: true, eligible: true });
  render(tree()); fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  const dialog = await screen.findByRole("dialog", { name: "Approve" });
  expect(within(dialog).getByLabelText("Next approver · Additional budget approval")).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Confirm approve" })).toBeEnabled();
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "director" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm approve" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ action: "approve", nextApproverUid: "director" })));
});
it("appends older immutable history pages without replacing the currently reviewed request", async () => {
  mocks.detail.mockImplementation(async (_, __, options = {}) => ({ request: structuredClone(request), budget, history: options.historyBeforeRevision ? [{ revision: 1, event: "create", actorName: "Sam Requester", createdAtMillis: 1792050000000, snapshot: { ...request, title: "Original request version" } }] : history, nextHistoryCursor: options.historyBeforeRevision ? null : 2 }));
  render(tree()); fireEvent.click(await screen.findByRole("button", { name: "Load older history" }));
  await screen.findByText("Draft created · Version 1");
  expect(mocks.detail).toHaveBeenLastCalledWith("hotel-a", "request-a", { historyBeforeRevision: 2 });
  expect(screen.getByRole("heading", { name: "Replacement plates" })).toBeInTheDocument();
  expect(screen.getByText("Draft saved · Version 2")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load older history" })).not.toBeInTheDocument();
});
it("validates incomplete quote inputs before reserving an uncertain command", async () => {
  render(tree("/purchase-requests/request-a/edit")); await screen.findByDisplayValue("Replacement plates");
  fireEvent.change(screen.getByLabelText("Net unit price (EUR)"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Enter a positive quantity and a net unit price");
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
});
it("keeps another requester's draft read-only even when the user can edit their own requests", async () => {
  request.requesterUid = "other-requester";
  render(tree("/purchase-requests/request-a/edit"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Only the requester can edit this draft");
  expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
  expect(mocks.mutate).not.toHaveBeenCalled();
});

it("uses the verified escalated route and candidates even when the context contains an old first-step authority", async () => {
  submissionApprovalRoute = escalatedSubmissionRoute();
  render(tree());
  const progress = await screen.findByRole("region", { name: "Approval progress" });
  expect(progress).toHaveTextContent("Department manager will be escalated to Finance");
  expect(progress).toHaveTextContent("The standard route requires an independent approver");
  expect(within(progress).getAllByRole("listitem")).toHaveLength(1);
  expect(progress).toHaveTextContent("1. Finance");
  fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
  const dialog = await screen.findByRole("dialog", { name: "Submit request" });
  const picker = within(dialog).getByLabelText("First approver · Finance");
  expect(within(picker).getByRole("option", { name: "Robin Finance" })).toBeInTheDocument();
  expect(within(picker).queryByRole("option", { name: "Alex Manager" })).not.toBeInTheDocument();
  expect(within(picker).queryByRole("option", { name: "Requester" })).not.toBeInTheDocument();
  fireEvent.change(picker, { target: { value: "finance" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm submit" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", { purchaseRequestId: "request-a", expectedRevision: 2, action: "submit", approverUid: "finance", expectedApprovalRouteFingerprint: routeFingerprint }));
});
it("keeps a route verification error readable and blocks submission until a successful refresh", async () => {
  submissionApprovalRoute = { steps: [], approvers: [], escalation: null, error: { code: "failed-precondition", message: "No independent Finance approver can review the full request." }, fingerprint: null };
  render(tree());
  expect(await screen.findByRole("heading", { name: "Replacement plates" })).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("No independent Finance approver");
  expect(screen.getByRole("button", { name: "Submit request" })).toBeDisabled();
  expect(screen.getByRole("region", { name: "Purchase lines" })).toHaveTextContent("Dinner plates");
  expect(mocks.mutate).not.toHaveBeenCalled();
  submissionApprovalRoute = escalatedSubmissionRoute();
  fireEvent.click(screen.getByRole("button", { name: "Refresh approval route" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Submit request" })).toBeEnabled());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("does not replace an empty authoritative candidate list with candidates from the context", async () => {
  submissionApprovalRoute = { ...escalatedSubmissionRoute(), approvers: [] };
  render(tree());
  expect(await screen.findByRole("button", { name: "Submit request" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("No eligible first approver is configured");
  expect(mocks.mutate).not.toHaveBeenCalled();
});
it("refreshes a changed approval route and automatically selects its sole candidate with the new fingerprint", async () => {
  submissionApprovalRoute = escalatedSubmissionRoute();
  mocks.mutate.mockRejectedValueOnce(new Error("The approval route changed. Refresh the request before submitting."));
  render(tree()); fireEvent.click(await screen.findByRole("button", { name: "Submit request" }));
  let dialog = await screen.findByRole("dialog", { name: "Submit request" });
  fireEvent.change(within(dialog).getByLabelText("First approver · Finance"), { target: { value: "finance" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm submit" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("approval route changed");
  submissionApprovalRoute = { steps: [{ id: "manager", name: "Department manager" }], approvers: [{ uid: "manager", name: "Alex Manager" }], escalation: null, error: null, fingerprint: "b".repeat(64) };
  fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh request" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Submit request" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
  dialog = await screen.findByRole("dialog", { name: "Submit request" });
  expect(within(dialog).getByLabelText("First approver · Department manager")).toHaveValue("manager");
  expect(within(dialog).getByRole("button", { name: "Confirm submit" })).toBeEnabled();
  fireEvent.change(within(dialog).getByLabelText("First approver · Department manager"), { target: { value: "manager" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm submit" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenLastCalledWith("hotel-a", expect.objectContaining({ approverUid: "manager", expectedApprovalRouteFingerprint: "b".repeat(64) })));
  expect(mocks.mutate).toHaveBeenCalledTimes(2);
});
it("retains the submitted escalation and route when current settings change, including the frozen history evidence", async () => {
  mocks.auth.currentUser = { uid: "finance" }; request.status = "pending"; request.currentApproverUid = "finance"; request.currentApproverName = "Robin Finance";
  request.approvalSteps = [{ id: "finance", name: "Finance" }, { id: "director", name: "General manager" }]; request.approvalEscalation = firstStepEscalation;
  history = [{ revision: 2, event: "submit", actorName: "Sam Requester", snapshot: structuredClone(request) }];
  submissionApprovalRoute = null;
  context.settings.approvalSteps = [{ id: "changed", name: "New department step", thresholdMinor: 0 }];
  context.approvers.push({ uid: "director", name: "Taylor Director", stepIds: ["director"], limitMinor: 100000, eligible: true });
  render(tree());
  const progress = await screen.findByRole("region", { name: "Approval progress" });
  expect(progress).toHaveTextContent("Department manager was escalated to Finance");
  expect(progress).toHaveTextContent("1. Finance"); expect(progress).toHaveTextContent("2. General manager");
  expect(progress).not.toHaveTextContent("New department step");
  expect(progress).not.toHaveTextContent("Approved by Sam Requester");
  const timeline = screen.getByRole("region", { name: "Request timeline" });
  fireEvent.click(within(timeline).getByText("View frozen version"));
  expect(timeline).toHaveTextContent("Department manager was escalated to Finance");
  expect(timeline).toHaveTextContent("Approval route: Finance → General manager");
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  const dialog = await screen.findByRole("dialog", { name: "Approve" });
  expect(within(dialog).getByLabelText("Next approver · General manager")).toBeInTheDocument();
  expect(within(dialog).getByRole("option", { name: "Taylor Director" })).toBeInTheDocument();
});
it("previews a returned request's new route rather than its earlier submitted route", async () => {
  request.status = "returned"; request.approvalSteps = [{ id: "manager", name: "Department manager" }]; request.approvals = [{ stepId: "finance", approverUid: "finance", approverName: "Robin Finance" }];
  submissionApprovalRoute = escalatedSubmissionRoute();
  render(tree());
  const progress = await screen.findByRole("region", { name: "Approval progress" });
  expect(progress).toHaveTextContent("1. Finance");
  expect(progress).not.toHaveTextContent("1. Department manager");
  expect(progress).toHaveTextContent("will be escalated to Finance");
  expect(progress).not.toHaveTextContent("Approved by Robin Finance");
});
it("does not invent an escalation for a legacy response without a verified submission route", async () => {
  context.approvers = context.approvers.filter((person) => person.uid !== "manager");
  render(tree());
  expect(await screen.findByRole("button", { name: "Submit request" })).toBeDisabled();
  expect(screen.queryByText(/will be escalated/)).not.toBeInTheDocument();
  expect(mocks.mutate).not.toHaveBeenCalled();
});
it("blocks an unverifiable route fingerprint without hiding the request", async () => {
  submissionApprovalRoute = { ...escalatedSubmissionRoute(), fingerprint: null };
  render(tree());
  expect(await screen.findByRole("button", { name: "Submit request" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("approval route could not be verified");
  expect(screen.getByRole("region", { name: "Purchase lines" })).toBeInTheDocument();
});
it("prepares supplier products from two suppliers in one request and sends each line's explicit supplier and pack", async () => {
  context.suppliers.push({ id: "repairs", name: "Local Repairs" });
  mocks.context.mockImplementation(async (_, options = {}) => structuredClone({ ...context, ...(options.budgetMonth ? { budget } : {}), supplierProducts: options.supplierId === "supplier" ? [{ id: "plates", supplierProductName: "White plates", supplierSku: "P-1", purchaseUnit: "each", pricePerPurchaseUnit: "1.005001", currency: "EUR", purchaseOptions: [{ id: "carton", label: "Carton", purchaseUnit: "carton", pricePerPurchaseUnit: "12.345678" }] }] : options.supplierId === "repairs" ? [{ id: "service", supplierProductName: "Repair service", purchaseUnit: "hour", pricePerPurchaseUnit: "25.123456", currency: "EUR" }] : [] }));
  render(tree("/purchase-requests/request-a/edit"));
  const first = await screen.findByRole("article", { name: "Purchase line 1" });
  fireEvent.click(within(first).getByRole("button", { name: "Choose supplier product" }));
  fireEvent.click(await within(first).findByRole("button", { name: "Use Carton · €12.345678" }));
  expect(within(first).getByLabelText("Quantity")).toHaveValue(10);
  expect(within(first).getByLabelText("Unit")).toHaveValue("carton");
  fireEvent.click(screen.getByRole("button", { name: "Add purchase line" }));
  const second = screen.getByRole("article", { name: "Purchase line 2" });
  fireEvent.change(within(second).getByLabelText("Line 2 supplier"), { target: { value: "repairs" } });
  fireEvent.click(within(second).getByRole("button", { name: "Choose supplier product" }));
  expect(within(second).queryByText("White plates")).not.toBeInTheDocument();
  fireEvent.click(await within(second).findByRole("button", { name: "Use hour · €25.123456" }));
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
  const saved = mocks.mutate.mock.calls[0][1].draft;
  expect(saved).not.toHaveProperty("supplierId");
  expect(saved.lines).toEqual([
    { id: "line-a", kind: "supplier", supplierId: "supplier", supplierProductId: "plates", purchaseOptionId: "carton", description: "White plates", quantity: "10", unitPrice: "12.345678", unit: "carton" },
    { id: expect.any(String), kind: "supplier", supplierId: "repairs", supplierProductId: "service", description: "Repair service", quantity: "1", unitPrice: "25.123456", unit: "hour" },
  ]);
});
it("clears only the changed line's supplier identities, quotation and package unit while preserving descriptions and quantities", async () => {
  context.suppliers.push({ id: "repairs", name: "Local Repairs" });
  request.lines = [{ ...request.lines[0], kind: "supplier", supplierId: "supplier", supplierProductId: "old-plates", purchaseOptionId: "old-case", unit: "case" }, { id: "line-b", kind: "free", supplierId: "repairs", description: "Fix shelf", quantity: 2, unitPrice: "8.765432", unit: "hour" }];
  render(tree("/purchase-requests/request-a/edit"));
  const first = await screen.findByRole("article", { name: "Purchase line 1" }), second = screen.getByRole("article", { name: "Purchase line 2" });
  fireEvent.change(within(first).getByLabelText("Line 1 supplier"), { target: { value: "repairs" } });
  expect(within(first).getByLabelText("Line 1 description")).toHaveValue("Dinner plates");
  expect(within(first).getByLabelText("Quantity")).toHaveValue(10);
  expect(within(first).getByLabelText("Net unit price (EUR)")).toHaveValue(null);
  expect(within(first).getByLabelText("Unit")).toHaveValue("each");
  expect(within(first).getByRole("status")).toHaveTextContent("Supplier changed");
  expect(within(second).getByLabelText("Net unit price (EUR)")).toHaveValue(8.765432);
  expect(within(second).getByLabelText("Unit")).toHaveValue("hour");
  fireEvent.change(within(first).getByLabelText("Net unit price (EUR)"), { target: { value: "1.234567" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
  expect(mocks.mutate.mock.calls[0][1].draft.lines).toEqual([
    { id: "line-a", kind: "free", supplierId: "repairs", description: "Dinner plates", quantity: "10", unitPrice: "1.234567", unit: "each" },
    { id: "line-b", kind: "free", supplierId: "repairs", description: "Fix shelf", quantity: "2", unitPrice: "8.765432", unit: "hour" },
  ]);
});
it("also clears a free line's quotation when its supplier changes", async () => {
  context.suppliers.push({ id: "repairs", name: "Local Repairs" });
  request.lines[0].unit = "hour";
  render(tree("/purchase-requests/request-a/edit"));
  fireEvent.change(await screen.findByLabelText("Line 1 supplier"), { target: { value: "repairs" } });
  expect(screen.getByLabelText("Net unit price (EUR)")).toHaveValue(null);
  expect(screen.getByLabelText("Line 1 description")).toHaveValue("Dinner plates");
  expect(screen.getByLabelText("Unit")).toHaveValue("hour");
});
it("ignores an old supplier's delayed product results after changing the line supplier", async () => {
  context.suppliers.push({ id: "repairs", name: "Local Repairs" });
  let resolveOld;
  mocks.context.mockImplementation(async (_, options = {}) => {
    if (options.supplierId === "supplier") return new Promise((resolve) => { resolveOld = resolve; });
    return structuredClone({ ...context, ...(options.budgetMonth ? { budget } : {}), supplierProducts: options.supplierId === "repairs" ? [{ id: "service", supplierProductName: "Current repair service", purchaseUnit: "hour", pricePerPurchaseUnit: "20", currency: "EUR" }] : [] });
  });
  render(tree("/purchase-requests/request-a/edit"));
  fireEvent.click(await screen.findByRole("button", { name: "Choose supplier product" }));
  await waitFor(() => expect(resolveOld).toBeDefined());
  fireEvent.change(screen.getByLabelText("Line 1 supplier"), { target: { value: "repairs" } });
  fireEvent.click(screen.getByRole("button", { name: "Choose supplier product" }));
  await screen.findByText("Current repair service");
  await act(async () => resolveOld({ ...context, supplierProducts: [{ id: "stale", supplierProductName: "Old supplier product", purchaseUnit: "case", pricePerPurchaseUnit: "999" }] }));
  expect(screen.queryByText("Old supplier product")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Use hour · €20.00" }));
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ draft: expect.objectContaining({ lines: [expect.objectContaining({ supplierId: "repairs", supplierProductId: "service", unitPrice: "20" })] }) })));
});
it("cancels an in-flight product choice without changing the line or showing late results", async () => {
  let resolveProducts;
  mocks.context.mockImplementation(async (_, options = {}) => options.supplierId ? new Promise((resolve) => { resolveProducts = resolve; }) : structuredClone({ ...context, ...(options.budgetMonth ? { budget } : {}) }));
  render(tree("/purchase-requests/request-a/edit"));
  fireEvent.click(await screen.findByRole("button", { name: "Choose supplier product" }));
  await waitFor(() => expect(resolveProducts).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Cancel product selection" }));
  await act(async () => resolveProducts({ ...context, supplierProducts: [{ id: "late", supplierProductName: "Canceled product", pricePerPurchaseUnit: 999 }] }));
  expect(screen.queryByText("Canceled product")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Find supplier products")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Line 1 description")).toHaveValue("Dinner plates");
  expect(screen.getByLabelText("Net unit price (EUR)")).toHaveValue(15);
});
it("removes an in-flight product picker with its line and keeps the remaining line unchanged", async () => {
  let resolveProducts;
  request.lines.push({ id: "line-b", kind: "free", supplierId: "supplier", description: "Keep this line", quantity: 2, unitPrice: 4, unit: "each" });
  mocks.context.mockImplementation(async (_, options = {}) => options.supplierId ? new Promise((resolve) => { resolveProducts = resolve; }) : structuredClone({ ...context, ...(options.budgetMonth ? { budget } : {}) }));
  render(tree("/purchase-requests/request-a/edit"));
  const first = await screen.findByRole("article", { name: "Purchase line 1" });
  fireEvent.click(within(first).getByRole("button", { name: "Choose supplier product" }));
  await waitFor(() => expect(resolveProducts).toBeDefined());
  fireEvent.click(within(first).getByRole("button", { name: "Remove line 1" }));
  await act(async () => resolveProducts({ ...context, supplierProducts: [{ id: "removed", supplierProductName: "Removed line result" }] }));
  expect(screen.queryByText("Removed line result")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Line 1 description")).toHaveValue("Keep this line");
  expect(screen.getByLabelText("Net unit price (EUR)")).toHaveValue(4);
});
it("keeps the budget preview independent of choosing a supplier and saves an explicit unknown line supplier in a draft", async () => {
  request.lines[0].supplierId = "";
  render(tree("/purchase-requests/request-a/edit"));
  expect(await screen.findByLabelText("Line 1 supplier")).toHaveValue("");
  expect(await screen.findByRole("region", { name: "Budget impact" })).toHaveTextContent("€50.00");
  expect(mocks.context.mock.calls.every(([, options]) => !options?.supplierId)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ draft: expect.objectContaining({ lines: [expect.objectContaining({ supplierId: "" })] }) })));
});
it("hydrates an old header supplier only for lines without a supplier field and preserves an explicit unknown supplier", async () => {
  request.lines.push({ id: "line-b", kind: "free", supplierId: "", description: "Still choosing supplier", quantity: 1, unitPrice: 5, unit: "each" });
  render(tree("/purchase-requests/request-a/edit"));
  expect(await screen.findByLabelText("Line 1 supplier")).toHaveValue("supplier");
  expect(screen.getByLabelText("Line 2 supplier")).toHaveValue("");
});
it("shows an unavailable saved supplier by its snapshot name and allows an active replacement", async () => {
  request.supplierId = "inactive"; request.supplier = { id: "inactive", name: "Former Hotel Supplies" };
  render(tree("/purchase-requests/request-a/edit"));
  expect(await screen.findByRole("option", { name: "Former Hotel Supplies · Unavailable" })).toBeInTheDocument();
  expect(screen.getByText(/This saved supplier is no longer available/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Choose supplier product" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Line 1 supplier"), { target: { value: "supplier" } });
  expect(screen.getByRole("button", { name: "Choose supplier product" })).toBeEnabled();
  expect(screen.queryByText(/This saved supplier is no longer available/)).not.toBeInTheDocument();
});
it("drops delayed product results when hotel access changes", async () => {
  let resolveProducts;
  mocks.context.mockImplementation(async (_, options = {}) => options.supplierId ? new Promise((resolve) => { resolveProducts = resolve; }) : structuredClone({ ...context, ...(options.budgetMonth ? { budget } : {}) }));
  const view = render(tree("/purchase-requests/request-a/edit"));
  fireEvent.click(await screen.findByRole("button", { name: "Choose supplier product" }));
  await waitFor(() => expect(resolveProducts).toBeDefined());
  mocks.hotel = "hotel-b"; mocks.permissions = [];
  view.rerender(tree("/purchase-requests/request-a/edit"));
  await act(async () => resolveProducts({ ...context, supplierProducts: [{ id: "private", supplierProductName: "Previous hotel's product" }] }));
  expect(screen.queryByText("Previous hotel's product")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Line 1 description")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("permission to edit purchase requests");
});
it("keeps product currency warnings and requires a quotation rather than copying a foreign source price", async () => {
  context.supplierProducts = [{ id: "foreign", supplierProductName: "Foreign quoted article", purchaseUnit: "box", pricePerPurchaseUnit: "12.345678", currency: "USD", requiresQuote: true, priceValidity: "unknown", priceReviewReasons: ["price-source-date-unknown"] }];
  render(tree("/purchase-requests/request-a/edit"));
  fireEvent.click(await screen.findByRole("button", { name: "Choose supplier product" }));
  await screen.findByText("Foreign quoted article");
  fireEvent.click(screen.getByRole("button", { name: "Use box · $12.345678" }));
  expect(screen.getByLabelText("Net unit price (EUR)")).toHaveValue(null);
  expect(screen.getByText(/The source uses USD/)).toBeInTheDocument();
  expect(screen.getByText(/An explicit net quotation in EUR is required/)).toHaveTextContent("price source date is unknown");
  expect(screen.getByText("Price validity: Dates unknown")).toBeInTheDocument();
});

it("keeps Enter in the inline supplier search from saving the outer request form", async () => {
  render(tree("/purchase-requests/request-a/edit"));
  fireEvent.click(await screen.findByRole("button", { name: "Choose supplier product" }));
  const search = screen.getByLabelText("Find supplier products");
  fireEvent.change(search, { target: { value: "plate" } });
  const submitEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  expect(fireEvent(search, submitEvent)).toBe(false);
  expect(submitEvent.defaultPrevented).toBe(true);
  await waitFor(() => expect(mocks.context).toHaveBeenCalledWith("hotel-a", { supplierId: "supplier", query: "plate" }));
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(screen.getByTestId("location")).toHaveTextContent("/purchase-requests/request-a/edit");
});

it("keeps a supplier-only line and requires its quotation before saving instead of dropping the supplier choice", async () => {
  render(tree("/purchase-requests/new"));
  fireEvent.change(await screen.findByLabelText("Line 1 supplier"), { target: { value: "supplier" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Enter a positive quantity and a net unit price for each line");
  expect(screen.getByLabelText("Line 1 supplier")).toHaveValue("supplier");
  expect(screen.getByRole("article", { name: "Purchase line 1" })).toBeInTheDocument();
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
});
