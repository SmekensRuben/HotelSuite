import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ hotelUid: "hotel-a", actor: { uid: "manager" }, rights: new Set(), load: vi.fn(), save: vi.fn(), pending: vi.fn(), retry: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } } }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotelUid, permissions: [...mocks.rights], subscriptionActive: true }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.rights.has(`${feature}.${action}`) }));
vi.mock("../../services/firebasePurchaseRequests", () => ({ getPurchaseRequestSettings: mocks.load, savePurchaseRequestSettings: mocks.save, getPendingPurchaseRequestCommand: mocks.pending, retryPurchaseRequestCommand: mocks.retry }));
import PurchaseRequestSettingsSection from "./PurchaseRequestSettingsSection";

const members = [{ uid: "approver", displayName: "Hotel manager", eligible: true }, { uid: "reviewer", displayName: "Finance reviewer", eligible: true }, { uid: "reader", displayName: "Read-only member", eligible: false }];
const config = { revision: 3, currencyLocked: true, users: members, approvers: [members[0]],
  settings: { currency: "EUR", overBudgetMode: "block", costCentres: [{ id: "front-office", name: "Front office" }], budgetCategories: [{ id: "maintenance", name: "Maintenance" }], approvalSteps: [{ id: "department", name: "Department", thresholdMinor: 0 }, { id: "finance", name: "Finance", thresholdMinor: 100000 }], approvers: [{ uid: "approver", stepIds: ["department"], limitMinor: 200000, canApproveOverBudget: false }] } };
beforeEach(() => {
  vi.clearAllMocks(); mocks.hotelUid = "hotel-a"; mocks.actor = { uid: "manager" }; mocks.rights = new Set(["purchasebudgets.settings"]);
  mocks.load.mockResolvedValue(config); mocks.save.mockResolvedValue({}); mocks.pending.mockReturnValue(null); mocks.retry.mockResolvedValue({});
});
const show = () => render(<MemoryRouter><PurchaseRequestSettingsSection /></MemoryRouter>);

it("saves financial settings with stable category IDs, ordered steps and exact minor-unit authorities", async () => {
  show();
  await screen.findByDisplayValue("Front office");
  fireEvent.change(screen.getByLabelText("Cost centre 1 name"), { target: { value: "Rooms" } });
  fireEvent.change(screen.getByLabelText("Step 2 threshold"), { target: { value: "1500.25" } });
  fireEvent.change(screen.getByLabelText("Approver 1 limit"), { target: { value: "2500.29" } });
  fireEvent.change(screen.getByLabelText("Budget overspend policy"), { target: { value: "approval" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Purchase Request settings" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", { expectedRevision: 3, settings: {
    ...config.settings, overBudgetMode: "approval", costCentres: [{ id: "front-office", name: "Rooms" }], approvalSteps: [{ id: "department", name: "Department", thresholdMinor: 0 }, { id: "finance", name: "Finance", thresholdMinor: 150025 }], approvers: [{ uid: "approver", stepIds: ["department"], limitMinor: 250029, canApproveOverBudget: false }],
  } }));
  expect(screen.getByLabelText("Budget currency")).toBeDisabled();
});
it("reorders required steps without changing their identities or authority assignments", async () => {
  show(); await screen.findByDisplayValue("Department");
  fireEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));
  expect(screen.getByLabelText("Step 1 name")).toHaveValue("Finance");
  expect(screen.getByLabelText("Hotel manager — Department")).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Save Purchase Request settings" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(mocks.save.mock.calls[0][1].settings.approvalSteps.map((step) => step.id)).toEqual(["finance", "department"]);
});
it("never reads approval authorities without settings permission", () => {
  mocks.rights = new Set(["purchasebudgets.read"]); show(); expect(mocks.load).not.toHaveBeenCalled();
});
it("configures the first authority from the full member picker when no approvers are configured", async () => {
  mocks.load.mockResolvedValue({ ...config, revision: 0, approvers: [], settings: { ...config.settings, approvers: [] } });
  show(); await screen.findByRole("option", { name: "Hotel manager" });
  expect(screen.queryByRole("option", { name: "Read-only member" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Add eligible approver"), { target: { value: "approver" } });
  fireEvent.change(screen.getByLabelText("Approver 1 limit"), { target: { value: "500.00" } });
  fireEvent.click(screen.getByLabelText("Hotel manager — Department"));
  fireEvent.click(screen.getByRole("button", { name: "Save Purchase Request settings" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(mocks.save.mock.calls[0][1].settings.approvers).toEqual([{ uid: "approver", stepIds: ["department"], limitMinor: 50000, canApproveOverBudget: false }]);
});
it("recovers an uncertain settings command before allowing changed settings", async () => {
  mocks.pending.mockReturnValue({ requestId: "original" }); show();
  await screen.findByDisplayValue("Maintenance");
  expect(screen.getByLabelText("Step 1 name")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Verify original settings save" }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a", "settings"));
  expect(mocks.save).not.toHaveBeenCalled();
});
it("drops a late settings response when the selected hotel changes", async () => {
  let resolveOld; mocks.load.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
  const view = show(); await waitFor(() => expect(mocks.load).toHaveBeenCalled());
  mocks.hotelUid = "hotel-b"; mocks.load.mockResolvedValue({ ...config, settings: { ...config.settings, costCentres: [{ id: "new", name: "New property" }] } });
  view.rerender(<MemoryRouter><PurchaseRequestSettingsSection /></MemoryRouter>);
  await screen.findByDisplayValue("New property");
  await act(async () => resolveOld(config));
  expect(screen.queryByDisplayValue("Front office")).not.toBeInTheDocument();
});

it("explains the first-step exception, independent authority and retained later approvals", async () => {
  show(); await screen.findByDisplayValue("Department");
  expect(screen.getByText(/requester is the only eligible approver/)).toHaveTextContent("immediately next configured step, even below its threshold");
  expect(screen.getByText(/requester is the only eligible approver/)).toHaveTextContent("limit covering the full request");
  expect(screen.getByText(/requester is the only eligible approver/)).toHaveTextContent("No further steps are skipped; additional budget approval remains separate");
  expect(screen.getByText(/Self-approval is never allowed/)).toHaveTextContent("Each required step must be approved by a different person");
});
