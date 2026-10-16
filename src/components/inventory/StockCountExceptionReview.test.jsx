import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import StockCountExceptionReview from "./StockCountExceptionReview";
const mocks = vi.hoisted(() => ({ read: vi.fn(), permissions: ["stockcounts.read"], auth: { currentUser: { uid: "counter" } } }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.permissions.includes(`${feature}.${action}`) }));
vi.mock("../../services/firebaseInventory", () => ({ getStockCountExceptions: mocks.read }));
const warning = () => ({ hotelUid: "hotel-a", stockCountId: "count", locationId: "store", finished: false, checkedThroughSequence: 8, checkedAtMillis: 1791799200000,
  issues: [{ code: "postings-during-count", detail: "Receipt receipt-9 arrived during count count at posting 8.", evidence: [{ movementId: "receipt-9", kind: "receipt", label: "Receipt", orderId: "order-4", sequence: 8, businessDate: "2026-10-12", lines: [{ catalogProductId: "milk", catalogProductName: "Milk", quantity: 12, baseUnit: "l" }] }] }] });
const show = (hotelUid = "hotel-a") => <StockCountExceptionReview hotelUid={hotelUid} stockCountId="count" locationId="store" revision={3} />;
beforeEach(() => { vi.clearAllMocks(); mocks.auth.currentUser = { uid: "counter" }; mocks.permissions = ["stockcounts.read"]; mocks.read.mockResolvedValue(warning()); });
it("shows the source event and safe follow-up without allowing a reader to acknowledge or correct uncertainty", async () => {
  render(show());
  expect(await screen.findByText("Receipt receipt-9 arrived during count count at posting 8.")).toBeInTheDocument();
  expect(screen.getByText("Milk · 12 l")).toBeInTheDocument();
  expect(screen.getByText(/Reviewing evidence does not clear uncertainty/)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Start a follow-up count" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Review source order/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /acknowledge|resolve|clear exception|mark reliable/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh count events" }));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("Receipt receipt-9 arrived during count count at posting 8.")).toBeInTheDocument();
});
it("offers only the existing authorized receiving and new-count workflows with the original count reference", async () => {
  mocks.permissions.push("orders.read", "orders.finalize", "stockcounts.create");
  render(show());
  expect(await screen.findByRole("link", { name: "Review receipt and correction options" })).toHaveAttribute("href", "/orders/order-4");
  expect(screen.getByRole("link", { name: "Start a follow-up count" })).toHaveAttribute("href", "/catalog/stock-counts/new?hotelUid=hotel-a&locationId=store&recountOf=count");
  expect(screen.getByRole("link", { name: "Start a follow-up count" })).toHaveAttribute("target", "_blank");
  expect(screen.getByRole("link", { name: "Review receipt and correction options" })).toHaveAttribute("target", "_blank");
  expect(screen.queryByRole("link", { name: /Review or correct movements/ })).not.toBeInTheDocument();
});
it("does not display late exception responses after hotel or permission changes", async () => {
  let resolve; mocks.read.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const view = render(show()); await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
  mocks.permissions = []; view.rerender(show("hotel-b")); await act(async () => resolve(warning()));
  expect(screen.queryByText(/receipt-9/)).not.toBeInTheDocument();
});
it("a failed evidence check remains visibly unverified and can be retried", async () => {
  mocks.read.mockRejectedValueOnce(new Error("Missing event sequence 8.")); render(show());
  expect(await screen.findByRole("alert")).toHaveTextContent("Count events could not be verified: Missing event sequence 8.");
  expect(screen.queryByText(/No recorded movement exceptions/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh count events" }));
  expect(await screen.findByText(/Receipt receipt-9 arrived/)).toBeInTheDocument();
});
