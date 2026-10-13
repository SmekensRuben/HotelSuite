import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import PendingCartCommand from "./PendingCartCommand";

const mocks = vi.hoisted(() => ({ actor: { currentUser: { uid: "buyer" } }, pending: vi.fn(), retry: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.actor }));
vi.mock("../../services/firebaseShoppingCarts", () => ({ getPendingCartCommand: mocks.pending, retryPendingCartCommand: mocks.retry }));
beforeEach(() => { vi.clearAllMocks(); mocks.actor.currentUser = { uid: "buyer" }; mocks.pending.mockReturnValue({ action: "outlet", expectedRevision: 8, value: "kitchen" }); });

it("shows recovery only after the page's own command has left normal progress", () => {
  const onPendingChange = vi.fn();
  const view = render(<PendingCartCommand hotelUid="hotel" cartId="cart" inFlight onPendingChange={onPendingChange} />);
  expect(screen.queryByText("A saved cart request needs reconciliation")).not.toBeInTheDocument();
  expect(onPendingChange).toHaveBeenCalledWith(true);
  view.rerender(<PendingCartCommand hotelUid="hotel" cartId="cart" onPendingChange={onPendingChange} />);
  expect(screen.getByText("A saved cart request needs reconciliation")).toBeInTheDocument();
  expect(screen.getByText(/unknown result/)).toBeInTheDocument();
});

it("keeps unreadable saved evidence blocked without crashing or discarding it", () => {
  const onPendingChange = vi.fn(); mocks.pending.mockImplementation(() => { throw new Error("Saved JSON is malformed"); });
  render(<PendingCartCommand hotelUid="hotel" cartId="cart" onPendingChange={onPendingChange} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Saved JSON is malformed");
  expect(onPendingChange).toHaveBeenCalledWith(true);
  expect(screen.getByRole("button", { name: "Retry saved cart request" })).toBeDisabled();
  expect(mocks.retry).not.toHaveBeenCalled();
});

it("does not apply an old actor's reconciliation callback after replacement", async () => {
  let resolve; mocks.retry.mockReturnValue(new Promise((done) => { resolve = done; })); const complete = vi.fn();
  render(<PendingCartCommand hotelUid="hotel" cartId="cart" onComplete={complete} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry saved cart request" }));
  mocks.actor.currentUser = { uid: "other-buyer" };
  await act(async () => resolve({ cartId: "cart", revision: 9 }));
  expect(complete).not.toHaveBeenCalled();
});
