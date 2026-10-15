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

let request, context, budget, history;
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname}</output>; }
function tree(path = "/purchase-requests/request-a") { return <MemoryRouter initialEntries={[path]}><Location /><Routes><Route path="/purchase-requests" element={<PurchaseRequestsPage />} /><Route path="/purchase-requests/new" element={<PurchaseRequestFormPage />} /><Route path="/purchase-requests/:purchaseRequestId" element={<PurchaseRequestDetailPage />} /><Route path="/purchase-requests/:purchaseRequestId/edit" element={<PurchaseRequestFormPage />} /></Routes></MemoryRouter>; }
beforeEach(() => {
  vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.auth.currentUser = { uid: "requester" }; mocks.permissions = ["purchaserequests.read", "purchaserequests.create", "purchaserequests.update", "purchaserequests.submit", "purchaserequests.approve", "purchaserequests.cancel", "purchasebudgets.read"];
  context = { settings: { currency: "EUR", costCentres: [{ id: "restaurant", name: "Restaurant" }], budgetCategories: [{ id: "chinaware", name: "Chinaware" }], approvalSteps: [{ id: "manager", name: "Department manager", thresholdMinor: 0 }, { id: "finance", name: "Finance", thresholdMinor: 20000 }], overBudgetMode: "block" }, suppliers: [{ id: "supplier", name: "Hotel Supplies" }], approvers: [{ uid: "requester", name: "Requester", stepIds: ["manager"], limitMinor: 100000, eligible: true }, { uid: "manager", name: "Alex Manager", stepIds: ["manager"], limitMinor: 100000, eligible: true }, { uid: "finance", name: "Robin Finance", stepIds: ["finance"], limitMinor: 100000, eligible: true }, { uid: "revoked", name: "Removed approver", stepIds: ["manager"], limitMinor: 100000, eligible: false }], supplierProducts: [] };
  budget = { exists: true, id: "2026-10__chinaware", month: "2026-10", categoryId: "chinaware", budgetMinor: 50000, openingUsedMinor: 0, pendingMinor: 0, committedMinor: 30000, remainingMinor: 20000 };
  request = { id: "request-a", hotelUid: "hotel-a", revision: 2, status: "draft", requesterUid: "requester", requesterName: "Sam Requester", currency: "EUR", supplierId: "supplier", supplier: { id: "supplier", name: "Hotel Supplies" }, title: "Replacement plates", description: "Replace damaged dinner plates", motivation: "Maintain enough plates for dinner service", costCentreId: "restaurant", costCentreName: "Restaurant", budgetCategoryId: "chinaware", budgetCategoryName: "Chinaware", budgetMonth: "2026-10", totalMinor: 15000, lines: [{ id: "line-a", kind: "free", description: "Dinner plates", quantity: 10, unitPrice: 15, unit: "each", lineTotalMinor: 15000 }], attachmentIds: [], attachments: [], approvals: [], approvalSteps: [], currentStepIndex: 0, reservation: { state: "none", amountMinor: 0 } };
  history = [{ revision: 2, event: "save", actorName: "Sam Requester", createdAtMillis: 1792051200000, snapshot: structuredClone(request) }];
  mocks.pending.mockReturnValue(null);
  mocks.context.mockImplementation(async (_, options = {}) => structuredClone({ ...context, ...(options.budgetMonth && options.budgetCategoryId ? { budget } : {}) }));
  mocks.detail.mockImplementation(async () => structuredClone({ request, history, budget }));
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
  fireEvent.change(screen.getByLabelText("Supplier"), { target: { value: "supplier" } });
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
  await screen.findByText("Delivery-date quotation");
  expect(await screen.findByRole("region", { name: "Budget impact" })).toHaveTextContent("No budget is configured");
  fireEvent.click(screen.getByRole("button", { name: "Add Case" }));
  expect(screen.getAllByLabelText("Net unit price (EUR)")[1]).toHaveValue(null);
  expect(screen.getByText("An explicit net quotation in EUR is required.")).toBeInTheDocument();
  expect(screen.getByText(/Enter valid quantities and net unit prices/)).toBeInTheDocument();
});
it("continues through empty bounded supplier search windows to reach later matching articles", async () => {
  mocks.context.mockImplementation(async (_, options = {}) => ({ ...structuredClone(context), budget: structuredClone(budget), supplierProducts: options.cursor ? [{ id: "later", supplierProductName: "Later supplier article", supplierSku: "901", purchaseUnit: "box", pricePerPurchaseUnit: "1.005", currency: "EUR" }] : [], nextProductCursor: options.supplierId && !options.cursor ? "after-200" : null }));
  render(tree("/purchase-requests/request-a/edit"));
  fireEvent.click(await screen.findByRole("button", { name: "More supplier products" }));
  await screen.findByText("Later supplier article");
  expect(mocks.context).toHaveBeenLastCalledWith("hotel-a", expect.objectContaining({ cursor: "after-200", supplierId: "supplier" }));
  expect(screen.getByRole("button", { name: "Add box · €1.01" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add box · €1.01" }));
  expect(screen.getAllByLabelText("Net unit price (EUR)")[1]).toHaveValue(1.005);
});
it("requires a separate submission confirmation and an eligible non-self first approver", async () => {
  render(tree()); await screen.findByRole("button", { name: "Submit request" });
  fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
  const dialog = await screen.findByRole("dialog", { name: "Submit request" });
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(within(dialog).queryByRole("option", { name: "Requester" })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("option", { name: "Removed approver" })).not.toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Confirm submit" })).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "manager" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm submit" }));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("hotel-a", { purchaseRequestId: "request-a", expectedRevision: 2, action: "submit", approverUid: "manager" }));
});
it("requires the next authorized person and does not offer previous approvers for another step", async () => {
  mocks.auth.currentUser = { uid: "manager" }; request.status = "pending"; request.currentApproverUid = "manager"; request.currentApproverName = "Alex Manager"; request.approvalSteps = [{ id: "manager", name: "Department manager" }, { id: "finance", name: "Finance" }]; request.reservation = { state: "pending", amountMinor: 15000, bucketId: "2026-10__chinaware" };
  context.approvers.push({ uid: "manager", name: "Same manager", stepIds: ["finance"], limitMinor: 100000, eligible: true });
  render(tree()); fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  const dialog = await screen.findByRole("dialog", { name: "Approve" });
  expect(within(dialog).getByRole("button", { name: "Confirm approve" })).toBeDisabled();
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
  expect(timeline).toHaveTextContent("Dinner plates: 10 each × 15 EUR net = €150.00");
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
  expect(within(dialog).getByRole("button", { name: "Confirm approve" })).toBeDisabled();
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
