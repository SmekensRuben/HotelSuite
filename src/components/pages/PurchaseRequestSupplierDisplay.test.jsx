import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: { currentUser: { uid: "viewer" } }, context: vi.fn(), list: vi.fn(), detail: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: "hotel-a", permissions: ["purchaserequests.read"] }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => feature === "purchaserequests" && action === "read" }));
vi.mock("../layout/PageShell", () => ({ default: ({ children }) => <main>{children}</main> }));
vi.mock("../../services/firebasePurchaseRequests", () => ({ getPurchaseRequestContext: mocks.context, listPurchaseRequests: mocks.list, getPurchaseRequest: mocks.detail, getPendingPurchaseRequestCommand: () => null, mutatePurchaseRequest: vi.fn(), retryPurchaseRequestCommand: vi.fn() }));
vi.mock("../../services/firebasePurchaseRequestAttachments", () => ({ downloadPurchaseRequestAttachment: vi.fn() }));
vi.mock("../purchasing/PurchaseRequestNotifications", () => ({ default: () => null }));
import PurchaseRequestsPage from "./PurchaseRequestsPage";
import PurchaseRequestDetailPage from "./PurchaseRequestDetailPage";

const a = { id: "a", name: "Hotel Supplies" }, b = { id: "b", name: "Local Repairs" };
const line = (id, description, supplier) => ({ id, kind: "free", description, supplierId: supplier?.id || "", supplier, quantity: 1, unit: "each", unitPrice: 10, lineTotalMinor: 1000 });
let request, history;
beforeEach(() => {
  vi.clearAllMocks();
  request = { id: "request-a", title: "Kitchen equipment", revision: 2, status: "pending", requesterUid: "requester", requesterName: "Sam Requester", supplierId: "", supplier: null, suppliers: [a, b], currency: "EUR", totalMinor: 2000, costCentreName: "Kitchen", budgetCategoryName: "Equipment", budgetMonth: "2026-10", lines: [line("a", "Dinner plates", a), line("b", "Freezer repair", b)], approvalSteps: [], approvals: [], attachments: [] };
  history = [];
  mocks.context.mockResolvedValue({ settings: { costCentres: [], approvalSteps: [] }, approvers: [], suppliers: [{ id: "a", name: "Renamed live supplier" }] });
  mocks.list.mockImplementation(async () => ({ requests: [structuredClone(request)], nextCursor: null }));
  mocks.detail.mockImplementation(async () => ({ request: structuredClone(request), history: structuredClone(history), budget: null }));
});
function tree(path = "/purchase-requests/request-a") {
  return <MemoryRouter initialEntries={[path]}><Routes><Route path="/purchase-requests" element={<PurchaseRequestsPage />} /><Route path="/purchase-requests/:purchaseRequestId" element={<PurchaseRequestDetailPage />} /></Routes></MemoryRouter>;
}

it("identifies mixed suppliers and their saved names in the request list", async () => {
  render(tree("/purchase-requests"));
  const requestLink = await screen.findByRole("link", { name: /Kitchen equipment/ });
  expect(requestLink).toHaveTextContent("Multiple suppliers (2)");
  expect(requestLink).toHaveTextContent("Hotel Supplies · Local Repairs");
  expect(requestLink).not.toHaveTextContent("Supplier not selected");
  expect(requestLink).not.toHaveTextContent("Renamed live supplier");
});
it("shows a legacy header supplier in the list while making explicit unassigned lines visible", async () => {
  request.supplier = a; request.supplierId = "a";
  delete request.lines[0].supplierId; delete request.lines[0].supplier;
  request.lines[1] = line("b", "Unassigned quote", null);
  render(tree("/purchase-requests"));
  const requestLink = await screen.findByRole("link", { name: /Kitchen equipment/ });
  expect(requestLink).toHaveTextContent("Hotel Supplies");
  expect(requestLink).toHaveTextContent("1 line without a supplier");
  expect(requestLink).not.toHaveTextContent("Multiple suppliers");
  expect(requestLink).not.toHaveTextContent("Local Repairs");
});
it("shows the matching saved supplier beside every current purchase line", async () => {
  render(tree());
  const summary = await screen.findByRole("region", { name: "Request summary" });
  expect(summary).toHaveTextContent("Multiple suppliers (2)");
  expect(summary).toHaveTextContent("Hotel Supplies · Local Repairs");
  const articles = within(screen.getByRole("region", { name: "Purchase lines" })).getAllByRole("article");
  expect(articles[0]).toHaveTextContent("Dinner plates"); expect(articles[0]).toHaveTextContent("Supplier: Hotel Supplies");
  expect(articles[1]).toHaveTextContent("Freezer repair"); expect(articles[1]).toHaveTextContent("Supplier: Local Repairs");
  expect(screen.queryByText(/Renamed live supplier/)).not.toBeInTheDocument();
});
it("uses each frozen version's own supplier names and legacy fallback without inheriting explicit blanks", async () => {
  const snapshot = { ...structuredClone(request), supplier: { id: "old", name: "Historical wholesaler" }, supplierId: "old", lines: [
    { id: "legacy", description: "Old quote", quantity: 1, unit: "each", unitPrice: 10, lineTotalMinor: 1000 },
    line("blank", "Unassigned historical quote", null),
    line("specific", "Historical repair", { id: "historic", name: "Historical repair shop" }),
  ] };
  history = [{ event: "submit", revision: 1, actorName: "Sam", createdAtMillis: 1, snapshot }];
  render(tree());
  await screen.findByRole("region", { name: "Request summary" });
  const timeline = screen.getByRole("region", { name: "Request timeline" });
  fireEvent.click(within(timeline).getByText("View frozen version"));
  expect(timeline).toHaveTextContent("Multiple suppliers (2)");
  expect(timeline).toHaveTextContent("Historical wholesaler · Historical repair shop");
  expect(timeline).toHaveTextContent("Old quote · Supplier: Historical wholesaler");
  expect(timeline).toHaveTextContent("Unassigned historical quote · Supplier: Supplier not selected");
  expect(timeline).toHaveTextContent("Historical repair · Supplier: Historical repair shop");
  expect(timeline).not.toHaveTextContent("Hotel Supplies");
  expect(timeline).not.toHaveTextContent("Local Repairs");
});
