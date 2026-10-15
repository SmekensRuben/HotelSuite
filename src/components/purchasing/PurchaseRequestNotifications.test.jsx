import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(), retry: vi.fn() }));
vi.mock("../../services/firebasePurchaseRequestNotifications", () => ({ getPurchaseRequestNotifications: mocks.load, retryPurchaseRequestNotification: mocks.retry }));
import PurchaseRequestNotifications from "./PurchaseRequestNotifications";
beforeEach(() => { vi.clearAllMocks(); mocks.load.mockResolvedValue({ notifications: [] }); mocks.retry.mockResolvedValue({}); });
it("shows safe delivery states and offers retry only for explicitly recoverable failures", async () => {
  mocks.load.mockResolvedValue({ notifications: [
    { id: "failed", event: "submit", status: "failed", canRetry: true },
    { id: "unknown", event: "approved", status: "needs-review", canRetry: false },
  ] });
  render(<PurchaseRequestNotifications hotelUid="hotel-a" purchaseRequestId="request-a" revision={2} />);
  await screen.findByText("Delivery outcome needs review");
  expect(screen.getAllByRole("button", { name: "Retry email" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry email" }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel-a", "failed"));
  expect(screen.getByText(/Confirm the delivery outcome/)).toBeInTheDocument();
});
it("drops delayed notification status when the hotel changes", async () => {
  let resolve;
  mocks.load.mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue({ notifications: [] });
  const page = render(<PurchaseRequestNotifications hotelUid="hotel-a" purchaseRequestId="request-a" revision={2} />);
  page.rerender(<PurchaseRequestNotifications hotelUid="hotel-b" purchaseRequestId="request-b" revision={2} />);
  resolve({ notifications: [{ id: "private", event: "approved", status: "sent" }] });
  await screen.findByText("No email notifications for this revision.");
  expect(screen.queryByText(/Final approval/)).not.toBeInTheDocument();
});
it("clears previously loaded hotel statuses while the next hotel's delivery state loads", async () => {
  mocks.load.mockResolvedValueOnce({ notifications: [{ id: "private", event: "approved", status: "sent" }] });
  const page = render(<PurchaseRequestNotifications hotelUid="hotel-a" purchaseRequestId="request-a" revision={2} />);
  await screen.findByText("Sent");
  mocks.load.mockReturnValueOnce(new Promise(() => {}));
  page.rerender(<PurchaseRequestNotifications hotelUid="hotel-b" purchaseRequestId="request-b" revision={2} />);
  await screen.findByText("Loading email delivery status…");
  expect(screen.queryByText("Sent")).not.toBeInTheDocument();
});
it("refreshes status after a transition creates a new revision", async () => {
  const page = render(<PurchaseRequestNotifications hotelUid="hotel-a" purchaseRequestId="request-a" revision={2} />);
  await screen.findByText("No email notifications for this revision.");
  mocks.load.mockResolvedValue({ notifications: [{ id: "sent", event: "approve", status: "sent", canRetry: false }] });
  page.rerender(<PurchaseRequestNotifications hotelUid="hotel-a" purchaseRequestId="request-a" revision={3} />);
  await screen.findByText("Sent"); expect(mocks.load).toHaveBeenCalledTimes(2);
});
