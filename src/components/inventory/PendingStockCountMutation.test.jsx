import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ pending: vi.fn(), retry: vi.fn(), auth: { currentUser: { uid: "counter-a" } } }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth }));
vi.mock("../../services/firebaseStockCounts", () => ({ getPendingStockCountMutation: mocks.pending, retryPendingStockCountMutation: mocks.retry }));
import PendingStockCountMutation from "./PendingStockCountMutation";

const payload = { hotelUid: "hotel-a", stockCountId: "count-a", locationId: "bar", action: "save-location", requestId: "saved-request" };
const props = { hotelUid: "hotel-a", stockCountId: "count-a", locationId: "bar" };
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { mocks.pending.mockReset(); mocks.retry.mockReset(); mocks.auth.currentUser = { uid: "counter-a" }; mocks.pending.mockReturnValue(payload); });

describe("recovering pending stock count changes", () => {
  it("retries the stored command and reloads only after its outcome is confirmed", async () => {
    const onComplete = vi.fn(), onPendingChange = vi.fn();
    mocks.retry.mockImplementation(async () => { mocks.pending.mockReturnValue(null); return { revision: 4, locationRevision: 2 }; });
    render(<PendingStockCountMutation {...props} onComplete={onComplete} onPendingChange={onPendingChange} />);
    expect(onPendingChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry saved change" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({ revision: 4, locationRevision: 2 }, payload));
    expect(mocks.retry).toHaveBeenCalledWith("hotel-a", "count-a", "bar");
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("keeps uncertain changes available after a failed retry", async () => {
    mocks.retry.mockRejectedValue(new Error("Connection unavailable"));
    const onComplete = vi.fn(); render(<PendingStockCountMutation {...props} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry saved change" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection unavailable");
    expect(screen.getByRole("button", { name: "Retry saved change" })).toBeEnabled();
    expect(onComplete).not.toHaveBeenCalled();
  });
  it("does not complete a previous actor's retry after an account switch", async () => {
    const operation = deferred(), onComplete = vi.fn(); mocks.retry.mockReturnValue(operation.promise);
    const view = render(<PendingStockCountMutation {...props} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry saved change" }));
    mocks.auth.currentUser = { uid: "counter-b" }; mocks.pending.mockReturnValue(null);
    view.rerender(<PendingStockCountMutation {...props} onComplete={onComplete} />);
    await act(async () => { operation.resolve({ revision: 4 }); });
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("does not send a retry as a replacement account before React rerenders", () => {
    render(<PendingStockCountMutation {...props} />);
    mocks.auth.currentUser = { uid: "counter-b" };
    fireEvent.click(screen.getByRole("button", { name: "Retry saved change" }));
    expect(mocks.retry).not.toHaveBeenCalled();
  });
  it("does not invoke navigation or draft cleanup after unmount", async () => {
    const operation = deferred(), onComplete = vi.fn(); mocks.retry.mockReturnValue(operation.promise);
    const view = render(<PendingStockCountMutation {...props} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry saved change" }));
    view.unmount();
    await act(async () => { operation.resolve({ revision: 4 }); });
    expect(onComplete).not.toHaveBeenCalled();
  });
  it("blocks new saves when saved command storage cannot be read", () => {
    const onPendingChange = vi.fn(); mocks.pending.mockImplementation(() => { throw new Error("Saved change needs review"); });
    render(<PendingStockCountMutation {...props} onPendingChange={onPendingChange} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Saved change needs review");
    expect(onPendingChange).toHaveBeenCalledWith(true);
  });
});
