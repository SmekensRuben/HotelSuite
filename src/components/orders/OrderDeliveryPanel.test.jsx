import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import OrderDeliveryPanel from "./OrderDeliveryPanel";
const mocks = vi.hoisted(() => ({ read: vi.fn(), review: vi.fn(), permitted: true, actor: { uid: "manager" } }));
vi.mock("../../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } } }));
vi.mock("../../services/firebaseOrders", () => ({ getHotelOrderDelivery: mocks.read, reviewOrderDelivery: mocks.review }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: () => mocks.permitted }));
const base = (patch = {}) => ({ hotelUid: "a", orderId: "o", policyVersion: 1, orderRevision: 1, dispatchId: "dispatch-1", outcome: "unknown", status: "needs-review", method: "email", canRecordReview: true, canRecordReceipt: true, canRetryPreparation: false, events: [], nextCursor: null, ...patch });
const props = { hotelUid: "a", orderId: "o", orderRevision: 1, onChanged: vi.fn() };
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); mocks.actor = { uid: "manager" }; mocks.permitted = true; mocks.read.mockResolvedValue(base()); mocks.review.mockResolvedValue({ status: "sent" }); });
const enterReceipt = async () => {
  await screen.findByText("Delivery outcome unknown");
  fireEvent.change(screen.getByLabelText("Recovery action"), { target: { value: "record-receipt" } });
  fireEvent.change(screen.getByLabelText("Evidence reference or findings"), { target: { value: "Provider ID 123" } });
  fireEvent.change(screen.getByLabelText("Recovery reason"), { target: { value: "Reconcile timed out send" } });
};
it("shows unknown delivery guidance with receipt evidence and no option to resend", async () => {
  render(<OrderDeliveryPanel {...props} />);
  await screen.findByText("Delivery outcome unknown");
  expect(screen.getByText(/Do not create a replacement order or send it again/)).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Retry preparation" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save recovery action" })).toBeDisabled();
  await enterReceipt();
  fireEvent.click(screen.getByRole("button", { name: "Save recovery action" }));
  await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(1));
  expect(mocks.review.mock.calls[0][0]).toMatchObject({ hotelUid: "a", orderId: "o", expectedRevision: 1, action: "record-receipt", source: "email-provider", evidence: "Provider ID 123", reason: "Reconcile timed out send" });
  expect(screen.getByText(/does not record supplier acceptance/)).toBeInTheDocument();
});
it("preserves exact evidence and request identity across an uncertain result and a remount", async () => {
  mocks.review.mockRejectedValueOnce(new Error("Response timeout"));
  const view = render(<OrderDeliveryPanel {...props} />); await enterReceipt();
  fireEvent.click(screen.getByRole("button", { name: "Save recovery action" }));
  await screen.findByText(/result could not be confirmed/);
  const original = mocks.review.mock.calls[0][0];
  expect(screen.getByLabelText("Recovery reason")).toBeDisabled();
  view.unmount();
  render(<OrderDeliveryPanel {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved recovery request" }));
  await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(2));
  expect(mocks.review.mock.calls[1][0]).toEqual(original);
  await waitFor(() => expect(sessionStorage.getItem("delivery-recovery:manager:a:o")).toBeNull());
});
it("releases a rejected request only with server proof that it did not commit", async () => {
  mocks.review.mockRejectedValue(Object.assign(new Error("Order changed. Refresh before recording a recovery decision."), { details: { deliveryRequestUncommitted: true } }));
  render(<OrderDeliveryPanel {...props} />); await enterReceipt();
  fireEvent.click(screen.getByRole("button", { name: "Save recovery action" }));
  await screen.findByText(/Order changed/);
  await waitFor(() => expect(screen.getByLabelText("Recovery reason")).not.toBeDisabled());
  expect(screen.queryByRole("button", { name: "Retry saved recovery request" })).not.toBeInTheDocument();
});
it("readers get an explicit responsible role and still see evidence history", async () => {
  mocks.permitted = false;
  mocks.read.mockResolvedValue(base({ events: [{ id: "audit-1", action: "record-review", source: "supplier-contact", evidence: "Supplier is checking", reason: "Investigate original order", actorUid: "manager", revision: 1, createdAtMillis: 1, dispatchId: "dispatch-1" }] }));
  render(<OrderDeliveryPanel {...props} />); await screen.findByText(/Ask a hotel user with orders.recover/);
  expect(screen.queryByLabelText("Recovery action")).not.toBeInTheDocument();
  expect(screen.getByText("Evidence: Supplier is checking")).toBeInTheDocument();
  expect(screen.getByText("Reason: Investigate original order")).toBeInTheDocument();
});
it("preparation failure offers a configuration retry while transport acceptance remains separate from supplier confirmation", async () => {
  mocks.read.mockResolvedValueOnce(base({ outcome: "preparation-failed", canRetryPreparation: true, canRecordReceipt: false }))
    .mockResolvedValueOnce(base({ outcome: "transport-accepted", canRecordReview: false, canRecordReceipt: false }));
  render(<OrderDeliveryPanel {...props} />);
  await screen.findByText("Preparation failed before sending");
  expect(screen.queryByRole("option", { name: "Record verified delivery receipt" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Recovery action"), { target: { value: "retry-preparation" } });
  expect(screen.getByLabelText("Evidence source")).toHaveValue("configuration-review");
  fireEvent.click(screen.getByRole("button", { name: "Refresh delivery" }));
  await screen.findByText("Transport accepted the order");
  expect(screen.getByText(/This does not confirm that the supplier accepted the order/)).toBeInTheDocument();
});
it("ignores an obsolete hotel's evidence response", async () => {
  let resolve; mocks.read.mockImplementation(({ hotelUid }) => hotelUid === "a" ? new Promise((done) => { resolve = done; }) : Promise.resolve(base({ hotelUid: "b", outcome: "preparation-failed" })));
  const view = render(<OrderDeliveryPanel {...props} />);
  view.rerender(<OrderDeliveryPanel {...props} hotelUid="b" />);
  await screen.findByText("Preparation failed before sending");
  await act(async () => resolve(base()));
  expect(screen.queryByText("Delivery outcome unknown")).not.toBeInTheDocument();
});
it("allows a positively verified supplier receipt while leaving commercial acceptance separate", async () => {
  render(<OrderDeliveryPanel {...props} />); await enterReceipt();
  fireEvent.change(screen.getByLabelText("Evidence source"), { target: { value: "supplier-contact" } });
  fireEvent.change(screen.getByLabelText("Evidence reference or findings"), { target: { value: "Sam confirmed receipt of order o at 14:30" } });
  mocks.read.mockResolvedValue(base({ outcome: "receipt-verified", canRecordReceipt: false, canRecordReview: false }));
  fireEvent.click(screen.getByRole("button", { name: "Save recovery action" }));
  await screen.findByText("Supplier receipt verified");
  expect(mocks.review.mock.calls[0][0].source).toBe("supplier-contact");
  expect(screen.getByText(/Receipt does not confirm commercial acceptance/)).toBeInTheDocument();
});
