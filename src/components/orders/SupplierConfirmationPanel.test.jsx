import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import SupplierConfirmationPanel from "./SupplierConfirmationPanel";
import { invalidateProcurementReads } from "../../services/procurementReadPool";
const mocks = vi.hoisted(() => ({ read: vi.fn(), record: vi.fn(), review: vi.fn(), changed: vi.fn(), auth: { currentUser: { uid: "buyer" } }, permissions: [] }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ permissions: mocks.permissions, subscriptionActive: true, subscription: { modules: ["procurement"], status: "active", modulePolicyVersion: 1 } }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.permissions.includes(`${feature}.${action}`) }));
vi.mock("../../services/firebaseSupplierConfirmations", () => ({ getSupplierConfirmations: mocks.read, recordSupplierConfirmation: mocks.record, reviewSupplierConfirmation: mocks.review }));
const line = { supplierProductId: "juice", orderLineId: "case", productName: "Orange juice", purchaseUnit: "Case of 6", orderedQuantity: 10, orderedPrice: 10.6,
  deliveryDate: "2026-10-14", currency: "EUR", priceBasis: "gross", vatRate: 0.06 };
const data = (patch = {}) => ({ hotelUid: "hotel-a", orderId: "order", policyVersion: 1, orderRevision: 2, status: "Ordered", availability: "available", reason: null,
  releaseReady: true, today: "2026-10-13", submittedLines: [line], current: null, events: [], nextCursor: null, ...patch });
const proposal = (patch = {}) => ({ policyVersion: 1, responseId: "supplier-one", reviewId: null, responseType: "changes-proposed", respondedOn: "2026-10-13", eventCount: 1,
  reviewState: "pending", requiresAttention: true, review: null, response: { responseType: "changes-proposed", channel: "email", supplierReference: "REF-1", respondedOn: "2026-10-13", note: "", sourceDigest: "a".repeat(64),
    lines: [{ ...line, confirmedQuantity: 8, confirmedDeliveryDate: "2026-10-15", priceMode: "quoted", pricePerPurchaseUnit: 21.2, netPricePerPurchaseUnit: 20, substitute: null, deviations: ["quantity", "delivery-date", "price"], reason: "Two cases unavailable" }] }, ...patch });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const panel = (props = {}) => <SupplierConfirmationPanel hotelUid="hotel-a" orderId="order" orderRevision={2} onChanged={mocks.changed} {...props} />;
const openResponse = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Record supplier response" }));
  fireEvent.change(screen.getByLabelText("Supplier response reference"), { target: { value: "CONF-1" } });
};
beforeEach(() => {
  vi.clearAllMocks(); invalidateProcurementReads(); sessionStorage.clear(); mocks.auth.currentUser = { uid: "buyer" };
  mocks.permissions = ["orders.read", "orders.recordconfirmation", "orders.reviewconfirmation"];
  mocks.read.mockReset().mockResolvedValue(data()); mocks.record.mockReset().mockResolvedValue({}); mocks.review.mockReset().mockResolvedValue({}); mocks.changed.mockResolvedValue();
});
it("loads one coherent response with an animated skeleton and no invented supplier acceptance", async () => {
  const pending = deferred(); mocks.read.mockReturnValue(pending.promise); render(panel());
  expect(screen.getByText("Loading supplier responses…")).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Record supplier response" })).not.toBeInTheDocument();
  await act(async () => pending.resolve(data()));
  expect(await screen.findByText("No response recorded")).toBeInTheDocument(); expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(mocks.read).toHaveBeenCalledWith({ hotelUid: "hotel-a", orderId: "order" });
});
it("orders-only readers see evidence without confirmation or review privileges", async () => {
  mocks.permissions = ["orders.read"]; mocks.read.mockResolvedValue(data({ current: proposal() })); render(panel());
  await screen.findByText(/Supplier proposed changes/);
  expect(screen.queryByRole("button", { name: "Record supplier response" })).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Accept proposed terms" })).not.toBeInTheDocument();
});
it("records a full acceptance with original quantity/date and one exact scoped request without a transient recovery warning", async () => {
  const saving = deferred(); mocks.record.mockReturnValue(saving.promise); render(panel()); await openResponse();
  fireEvent.click(screen.getByRole("button", { name: "Save supplier response" }));
  await screen.findByText("Saving the supplier response…"); expect(screen.queryByText(/A saved supplier request needs confirmation/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save supplier response" })); expect(mocks.record).toHaveBeenCalledTimes(1);
  expect(mocks.record.mock.calls[0][0]).toMatchObject({ hotelUid: "hotel-a", orderId: "order", expectedActorUid: "buyer", expectedRevision: 2,
    response: { responseType: "accepted", supplierReference: "CONF-1", respondedOn: "2026-10-13", lines: [{ supplierProductId: "juice", orderLineId: "case", confirmedQuantity: 10, deliveryDate: "2026-10-14", priceMode: "as-ordered" }] } });
  await act(async () => saving.resolve({})); await screen.findByText(/Supplier response recorded/); expect(sessionStorage.length).toBe(0); expect(mocks.changed).toHaveBeenCalledTimes(1);
});
it("blank quantities/prices are not zero and an explicit quoted zero survives the draft", async () => {
  render(panel()); await openResponse(); fireEvent.change(screen.getByLabelText("Supplier response"), { target: { value: "changes-proposed" } });
  fireEvent.change(screen.getByLabelText("Confirmed quantity · Orange juice (Case of 6)"), { target: { value: "" } });
  const button = screen.getByRole("button", { name: "Save supplier response" }); fireEvent.submit(button.closest("form"));
  expect(mocks.record).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Confirmed quantity · Orange juice (Case of 6)"), { target: { value: "0" } });
  fireEvent.change(screen.getByLabelText("Package price status · Orange juice"), { target: { value: "quoted" } });
  fireEvent.submit(button.closest("form")); expect(mocks.record).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(/Quoted package price · Orange juice/), { target: { value: "0" } });
  fireEvent.change(screen.getByLabelText("Change explanation · Orange juice"), { target: { value: "Supplier offered a genuine free case" } });
  fireEvent.submit(button.closest("form")); await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));
  expect(mocks.record.mock.calls[0][0].response.lines[0]).toMatchObject({ confirmedQuantity: 0, pricePerPurchaseUnit: 0, priceMode: "quoted" });
});
it("explicit unknown delivery dates and prices remain null/unknown rather than becoming current terms", async () => {
  render(panel()); await openResponse(); fireEvent.change(screen.getByLabelText("Supplier response"), { target: { value: "changes-proposed" } });
  fireEvent.click(screen.getByLabelText("Delivery date unknown · Orange juice")); fireEvent.change(screen.getByLabelText("Package price status · Orange juice"), { target: { value: "unknown" } });
  fireEvent.change(screen.getByLabelText("Change explanation · Orange juice"), { target: { value: "Supplier could not quote these values" } });
  fireEvent.click(screen.getByRole("button", { name: "Save supplier response" })); await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));
  expect(mocks.record.mock.calls[0][0].response.lines[0]).toMatchObject({ deliveryDate: null, priceMode: "unknown" });
  expect(mocks.record.mock.calls[0][0].response.lines[0]).not.toHaveProperty("pricePerPurchaseUnit");
});
it("an uncertain response survives remount and retries the original revision/payload even after the order changes", async () => {
  mocks.record.mockRejectedValueOnce(new Error("Network lost")).mockResolvedValueOnce({}); const view = render(panel()); await openResponse();
  fireEvent.click(screen.getByRole("button", { name: "Save supplier response" })); await screen.findByText(/The result is uncertain/);
  const original = mocks.record.mock.calls[0][0]; view.unmount(); mocks.read.mockResolvedValue(data({ orderRevision: 3 })); render(panel({ orderRevision: 3 }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved supplier request" })); await screen.findByText(/Supplier response recorded/);
  expect(mocks.record.mock.calls[1][0]).toEqual(original); expect(sessionStorage.length).toBe(0);
});
it("only proven uncommitted failures release a command; a failed rollout leaves exact recovery", async () => {
  mocks.record.mockRejectedValueOnce({ message: "Order changed", details: { confirmationRequestUncommitted: true } }).mockRejectedValueOnce({ message: "Platform paused" });
  render(panel()); await openResponse(); fireEvent.click(screen.getByRole("button", { name: "Save supplier response" }));
  await screen.findByText("Order changed"); expect(sessionStorage.length).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Save supplier response" })); await screen.findByText(/The result is uncertain/); expect(sessionStorage.length).toBe(1);
});
it("a verified saved change is not presented as an uncertain write when the parent refresh fails", async () => {
  mocks.changed.mockRejectedValue(new Error("Parent order refresh failed")); render(panel()); await openResponse();
  fireEvent.click(screen.getByRole("button", { name: "Save supplier response" }));
  await screen.findByText(/The supplier change was saved, but the order could not be refreshed/);
  expect(sessionStorage.length).toBe(0); expect(screen.queryByRole("button", { name: "Retry saved supplier request" })).not.toBeInTheDocument(); expect(mocks.record).toHaveBeenCalledTimes(1);
});
it("browser persistence failure prevents sending and malformed saved commands cannot be retried", async () => {
  sessionStorage.setItem("supplier-confirmation-request:buyer:hotel-a:order", "malformed"); const view = render(panel());
  await screen.findByText(/The saved supplier request cannot be read/); expect(screen.queryByRole("button", { name: "Retry saved supplier request" })).not.toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Record supplier response" })).toBeDisabled(); view.unmount(); sessionStorage.clear(); render(panel()); await openResponse();
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Unavailable storage"); });
  fireEvent.click(screen.getByRole("button", { name: "Save supplier response" })); await screen.findByText(/No command was sent/); expect(mocks.record).not.toHaveBeenCalled(); spy.mockRestore();
});
it("explicit review references the latest response and preserves original snapshot policy", async () => {
  mocks.read.mockResolvedValue(data({ current: proposal() })); render(panel()); const accept = await screen.findByRole("button", { name: "Accept proposed terms" });
  expect(accept).toBeDisabled(); fireEvent.change(screen.getByLabelText("Hotel review reason"), { target: { value: "Accepted after supplier discussion" } }); fireEvent.click(accept);
  await screen.findByText(/Hotel review recorded/); expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2,
    review: { responseId: "supplier-one", decision: "accept", reason: "Accepted after supplier discussion" } }));
});
it("replacement/rejection proposals expose follow-up without accepting original-product inventory", async () => {
  const replacement = proposal(); replacement.response.lines[0].substitute = { description: "Apple juice", supplierSku: "APPLE", purchaseUnit: "Bottle" };
  mocks.read.mockResolvedValue(data({ current: replacement })); render(panel()); await screen.findByText(/Replacement proposal: Apple juice/);
  expect(screen.queryByRole("button", { name: "Accept proposed terms" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Hotel review reason"), { target: { value: "Obtain a verified replacement order" } }); fireEvent.click(screen.getByRole("button", { name: "Request supplier follow-up" }));
  await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(1)); expect(mocks.review.mock.calls[0][0].review.decision).toBe("follow-up");
});
it("refresh retains verified evidence while loading, but clears failed verification and requires retry", async () => {
  mocks.read.mockResolvedValueOnce(data({ current: proposal() })); const later = deferred(); mocks.read.mockReturnValueOnce(later.promise); render(panel());
  await screen.findByText(/Supplier proposed changes/); fireEvent.click(screen.getByRole("button", { name: "Refresh responses" }));
  expect(screen.getByText(/Supplier proposed changes/)).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Record supplier response" })).toBeDisabled();
  await act(async () => later.reject(new Error("Responses unavailable"))); await screen.findByText("Responses unavailable"); expect(screen.queryByText(/Supplier proposed changes/)).not.toBeInTheDocument();
  mocks.read.mockResolvedValue(data()); fireEvent.click(screen.getByRole("button", { name: "Retry" })); await screen.findByText("No response recorded");
});
it("newer source revisions block stale response drafts and clear review reasons", async () => {
  mocks.read.mockResolvedValueOnce(data({ current: proposal() })).mockResolvedValueOnce(data({ orderRevision: 3, current: proposal({ responseId: "supplier-two" }) }));
  render(panel()); await openResponse(); fireEvent.change(screen.getByLabelText("Hotel review reason"), { target: { value: "Old proposal reason" } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh responses" })); await screen.findByText(/The order changed while this response was being drafted/);
  expect(screen.getByLabelText("Hotel review reason")).toHaveValue(""); expect(screen.getByRole("button", { name: "Save supplier response" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Start with current terms" })); expect(screen.getByRole("button", { name: "Save supplier response" })).not.toBeDisabled();
});
it("same-UID Auth replacement, lost permissions and hotel changes never reveal late old responses", async () => {
  const old = deferred(); mocks.read.mockReturnValueOnce(old.promise).mockResolvedValue(data({ hotelUid: "hotel-b" })); const view = render(panel());
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1)); mocks.auth.currentUser = { uid: "buyer" }; view.rerender(panel({ hotelUid: "hotel-b" }));
  await screen.findByText("No response recorded"); await act(async () => old.resolve(data({ current: proposal() })));
  expect(screen.queryByText(/Supplier proposed changes/)).not.toBeInTheDocument(); mocks.permissions = []; view.rerender(panel({ hotelUid: "hotel-b" }));
  expect(screen.queryByRole("region", { name: "Supplier confirmation" })).not.toBeInTheDocument();
});
it("history paging checks revisions, duplicate/cyclic cursors and keeps a retryable error", async () => {
  const event = { id: "old", kind: "review", revision: 2, actorName: "Hotel Buyer", createdAtMillis: 1, response: null, review: { decision: "follow-up", reason: "Contact supplier" } };
  mocks.read.mockResolvedValueOnce(data({ events: [event], nextCursor: "old" })).mockResolvedValueOnce(data({ events: [event], nextCursor: "old" })); render(panel());
  fireEvent.click(await screen.findByRole("button", { name: "Load older responses" })); await screen.findByText(/Supplier history changed or did not advance/);
  expect(screen.getByRole("button", { name: "Record supplier response" })).toBeDisabled();
});
