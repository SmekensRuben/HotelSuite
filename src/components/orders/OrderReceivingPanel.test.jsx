import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import OrderReceivingPanel from "./OrderReceivingPanel";
const mocks = vi.hoisted(() => ({ read: vi.fn(), receive: vi.fn(), reverse: vi.fn(), close: vi.fn(), changed: vi.fn(), rights: ["receive"] }));
vi.mock("../../firebaseConfig", () => ({ auth: { currentUser: { uid: "receiver" } } }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (_, action) => mocks.rights.includes(action) }));
vi.mock("../../services/firebaseOrders", () => ({ getHotelOrderReceiving: mocks.read, recordHotelOrderReceipt: mocks.receive, reverseHotelOrderReceipt: mocks.reverse, finalizeHotelOrderReceiving: mocks.close }));
const data = (extra = {}) => ({ hotelUid: "hotel-a", orderId: "order", policyVersion: 1, orderRevision: 7,
  availability: "available", releaseReady: true, status: "Ordered", receivingState: "partial", today: "2026-10-12",
  inventoryLocations: [{ id: "store", name: "Store" }], inventoryLocationsTruncated: false,
  lines: [{ supplierProductId: "coffee", productName: "Coffee", purchaseUnit: "box", orderedQuantity: 2.5, acceptedQuantity: 1.25, rejectedQuantity: 0.25, outstandingQuantity: 1.25, excessQuantity: 0 }],
  events: [], nextCursor: null, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fill = async () => {
  await screen.findByRole("button", { name: "Record goods receipt" });
  fireEvent.change(screen.getByLabelText("Delivery note / receipt reference"), { target: { value: "DN-2" } });
  fireEvent.change(screen.getByLabelText("Accepted Coffee"), { target: { value: "1.25" } });
  fireEvent.change(screen.getByLabelText("Physical receiving location"), { target: { value: "store" } });
};
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); mocks.rights = ["receive"];
  mocks.read.mockReset().mockResolvedValue(data()); mocks.receive.mockReset().mockResolvedValue({ eventId: "event" });
  mocks.reverse.mockReset().mockResolvedValue({ eventId: "reverse" }); mocks.close.mockReset().mockResolvedValue({ eventId: "closed" });
  mocks.changed.mockReset().mockResolvedValue();
});
it("uses the reviewed order revision and frozen purchase quantities, then refreshes", async () => {
  render(<OrderReceivingPanel hotelUid="hotel-a" orderId="order" onChanged={mocks.changed} />);
  await fill(); fireEvent.click(screen.getByRole("button", { name: "Record goods receipt" }));
  await screen.findByText("Goods receipt recorded.");
  expect(mocks.receive).toHaveBeenCalledWith(expect.objectContaining({ hotelUid: "hotel-a", orderId: "order", expectedRevision: 7,
    receivedOn: "2026-10-12", deliveryReference: "DN-2", lines: [{ supplierProductId: "coffee", acceptedQuantity: 1.25, rejectedQuantity: 0, reason: "" }] }));
  expect(mocks.changed).toHaveBeenCalledTimes(1);
  expect(sessionStorage.length).toBe(0);
});
it("does not send empty, whitespace-only, over-precision or unexplained discrepancy entries", async () => {
  render(<OrderReceivingPanel hotelUid="hotel-a" orderId="order" />);
  await fill();
  const form = screen.getByRole("button", { name: "Record goods receipt" }).closest("form");
  fireEvent.change(screen.getByLabelText("Delivery note / receipt reference"), { target: { value: "   " } });
  fireEvent.submit(form);
  expect(mocks.receive).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Delivery note / receipt reference"), { target: { value: "DN-2" } });
  for (const value of ["0.0001", "2", "0"]) {
    fireEvent.change(screen.getByLabelText("Accepted Coffee"), { target: { value } });
    fireEvent.submit(form); expect(mocks.receive).not.toHaveBeenCalled();
  }
});
it("preserves an uncertain command across remounts and retries the exact ID/payload/revision", async () => {
  mocks.receive.mockRejectedValueOnce(new Error("Response lost")).mockResolvedValueOnce({ eventId: "event" });
  const first = render(<OrderReceivingPanel hotelUid="hotel-a" orderId="order" />);
  await fill(); fireEvent.click(screen.getByRole("button", { name: "Record goods receipt" }));
  await screen.findByText(/The result could not be confirmed/);
  const original = mocks.receive.mock.calls[0][0];
  expect(screen.getByLabelText("Accepted Coffee")).toBeDisabled();
  first.unmount();
  mocks.read.mockResolvedValue(data({ orderRevision: 8 }));
  render(<OrderReceivingPanel hotelUid="hotel-a" orderId="order" />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved receiving request" }));
  await screen.findByText("Goods receipt recorded.");
  expect(mocks.receive.mock.calls[1][0]).toEqual(original);
  expect(mocks.receive.mock.calls[1][0].expectedRevision).toBe(7);
});
it("a precondition before idempotence does not discard an earlier uncertain command", async () => {
  mocks.receive.mockRejectedValueOnce(new Error("Response lost")).mockRejectedValueOnce({ code: "functions/failed-precondition", message: "Platform paused" });
  render(<OrderReceivingPanel hotelUid="hotel-a" orderId="order" />);
  await fill(); fireEvent.click(screen.getByRole("button", { name: "Record goods receipt" }));
  await screen.findByText(/The result could not be confirmed/);
  fireEvent.click(screen.getByRole("button", { name: "Retry saved receiving request" }));
  await waitFor(() => expect(mocks.receive).toHaveBeenCalledTimes(2));
  expect(JSON.parse(sessionStorage.getItem("receiving-request:receiver:hotel-a:order")).input).toEqual(mocks.receive.mock.calls[0][0]);
  expect(screen.getByLabelText("Accepted Coffee")).toBeDisabled();
});
it("an explicitly uncommitted revision conflict releases the draft and refreshes evidence", async () => {
  mocks.receive.mockRejectedValue({ code: "functions/aborted", message: "Order changed", details: { receivingRequestUncommitted: true } });
  render(<OrderReceivingPanel hotelUid="hotel-a" orderId="order" />);
  await fill(); fireEvent.click(screen.getByRole("button", { name: "Record goods receipt" }));
  await screen.findByText("Order changed");
  await waitFor(() => expect(screen.getByLabelText("Accepted Coffee")).not.toBeDisabled());
  expect(sessionStorage.length).toBe(0);
  expect(mocks.read).toHaveBeenCalledTimes(2);
});
it("read failures and historical unknown baselines cannot show valid totals or mutation controls", async () => {
  mocks.read.mockRejectedValueOnce(new Error("History offline")).mockResolvedValueOnce(data({ availability: "review-required", lines: null, receivingState: null, reason: "Historical baseline needs review" }));
  render(<OrderReceivingPanel hotelUid="hotel-a" orderId="order" />);
  await screen.findByText("History offline");
  expect(screen.queryByRole("button", { name: "Record goods receipt" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Historical baseline needs review");
  expect(screen.queryByRole("columnheader", { name: "Accepted" })).not.toBeInTheDocument();
});
it("orders-only readers see the evidence without gaining receiver/supervisor controls", async () => {
  mocks.rights = [];
  render(<OrderReceivingPanel hotelUid="hotel-a" orderId="order" />);
  await screen.findByText("Receiving status: partial");
  expect(screen.queryByRole("button", { name: /Record goods|Finalize|Reverse receipt/ })).not.toBeInTheDocument();
});
it("supervisor finalization requires shortage acknowledgement and passes the explicit reason", async () => {
  mocks.rights = ["finalize"];
  render(<OrderReceivingPanel hotelUid="hotel-a" orderId="order" />);
  const button = await screen.findByRole("button", { name: "Finalize receiving" });
  fireEvent.click(button); expect(mocks.close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(/Close this order with its outstanding/));
  fireEvent.change(screen.getByLabelText("Finalization reason"), { target: { value: "No further delivery" } });
  fireEvent.click(button); await screen.findByText("Receiving finalized.");
  expect(mocks.close).toHaveBeenCalledWith(expect.objectContaining({ acceptShortfall: true, reason: "No further delivery", expectedRevision: 7 }));
});
it("supervisor reverses with a reason; finalized histories hide all modification controls", async () => {
  mocks.rights = ["receive", "finalize"];
  const event = { id: "original", kind: "receipt", deliveryReference: "DN-1", actorUid: "receiver", lines: [], createdAtMillis: 1 };
  mocks.read.mockResolvedValue(data({ events: [event] }));
  const mounted = render(<OrderReceivingPanel hotelUid="hotel-a" orderId="order" />);
  fireEvent.click(await screen.findByRole("button", { name: "Reverse receipt DN-1" }));
  fireEvent.change(screen.getByLabelText("Reversal reason"), { target: { value: "Quantity entered twice" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm receipt reversal" }));
  await screen.findByText(/Receipt reversed; the original remains/);
  expect(mocks.reverse).toHaveBeenCalledWith(expect.objectContaining({ receiptId: "original", reason: "Quantity entered twice" }));
  mounted.unmount(); mocks.read.mockResolvedValue(data({ status: "Finalized", receivingState: "closed", events: [event], finalizationReason: "Supplier shortage accepted" }));
  render(<OrderReceivingPanel hotelUid="hotel-a" orderId="order" />);
  await screen.findByText(/Receiving is finalized/);
  expect(screen.queryByRole("button", { name: /Record goods|Finalize|Reverse receipt/ })).not.toBeInTheDocument();
});
it("a late old-hotel mutation cannot show success, refresh or inject its receipt in the new hotel", async () => {
  const old = deferred(); mocks.receive.mockReturnValue(old.promise);
  const mounted = render(<OrderReceivingPanel hotelUid="hotel-a" orderId="order" onChanged={mocks.changed} />);
  await fill(); fireEvent.click(screen.getByRole("button", { name: "Record goods receipt" }));
  mocks.read.mockResolvedValue(data({ hotelUid: "hotel-b" }));
  mounted.rerender(<OrderReceivingPanel hotelUid="hotel-b" orderId="order" onChanged={mocks.changed} />);
  await screen.findByText("Receiving status: partial");
  await act(async () => old.resolve({ eventId: "old" }));
  expect(screen.queryByText("Goods receipt recorded.")).not.toBeInTheDocument();
  expect(mocks.changed).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Accepted Coffee")).toHaveValue(null);
});
it("loads bounded history pages and exposes page failures without losing the current page", async () => {
  const first = { id: "one", kind: "receipt", deliveryReference: "DN-1", actorUid: "receiver", lines: [], createdAtMillis: 1 };
  mocks.read.mockResolvedValueOnce(data({ events: [first], nextCursor: "cursor" })).mockRejectedValueOnce(new Error("Older history offline"))
    .mockResolvedValueOnce(data({ events: [{ ...first, id: "two", deliveryReference: "DN-2" }], nextCursor: null }));
  render(<OrderReceivingPanel hotelUid="hotel-a" orderId="order" />);
  fireEvent.click(await screen.findByRole("button", { name: "Load older receiving events" }));
  await screen.findByText("Older history offline");
  expect(screen.getByText("Delivery DN-1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry history page" }));
  await screen.findByText("Delivery DN-2");
  expect(mocks.read).toHaveBeenLastCalledWith({ hotelUid: "hotel-a", orderId: "order", afterEventId: "cursor" });
  expect(within(screen.getByRole("region", { name: "Goods receiving" })).queryByRole("button", { name: "Load older receiving events" })).not.toBeInTheDocument();
});
