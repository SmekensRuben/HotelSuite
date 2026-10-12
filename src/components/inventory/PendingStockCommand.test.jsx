import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ pending: null, corrupt: false, retry: vi.fn(), countPending: null, countRetry: vi.fn() }));
vi.mock("../../services/firebaseSettings", () => ({ getPendingStockTemplateCommand: () => { if (mocks.corrupt) throw new Error("Saved request needs review; no replacement was created."); return mocks.pending; }, retryPendingStockTemplateCommand: mocks.retry }));
vi.mock("../../services/firebaseStockCounts", () => ({ getPendingCountCreation: () => mocks.countPending, retryPendingCountCreation: mocks.countRetry }));
import PendingStockCommand from "./PendingStockCommand";
beforeEach(() => { vi.clearAllMocks(); mocks.pending = null; mocks.corrupt = false; mocks.countPending = null; });
it("shows and retries saved template values after remount rather than current rows", async () => {
  mocks.pending = { action: "remove-item", item: { catalogProductId: "milk" }, expectedRevision: 6 };
  mocks.retry.mockResolvedValue({ revision: 7 });
  const done = vi.fn(); const initial = render(<PendingStockCommand hotelUid="hotel" locationId="store" templateId="t" />); initial.unmount();
  render(<PendingStockCommand hotelUid="hotel" locationId="store" templateId="t" onComplete={done} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved request" }));
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith("hotel", "store", "t"));
  await waitFor(() => expect(done).toHaveBeenCalledWith({ revision: 7 }));
});
it("keeps corrupt pending storage explicit and does not offer a new request", async () => {
  mocks.corrupt = true; render(<PendingStockCommand hotelUid="hotel" locationId="store" templateId="t" />);
  await screen.findByText("Saved request needs review; no replacement was created.");
  expect(screen.queryByRole("button", { name: "Retry saved request" })).not.toBeInTheDocument();
});
it("ignores late retry completion after changing hotels", async () => {
  let resolve; mocks.retry.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  mocks.pending = { action: "replace-items" }; const done = vi.fn();
  const view = render(<PendingStockCommand hotelUid="hotel-a" locationId="store" templateId="t" onComplete={done} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved request" }));
  mocks.pending = null; view.rerender(<PendingStockCommand hotelUid="hotel-b" locationId="store" templateId="t" onComplete={done} />);
  await act(async () => resolve({ revision: 7 })); expect(done).not.toHaveBeenCalled();
});
it("shows the original saved count name and retries its actor-scoped command", async () => {
  mocks.countPending = { name: "Original weekly count" }; mocks.countRetry.mockResolvedValue({ id: "count-a" });
  const done = vi.fn(); render(<PendingStockCommand kind="count" hotelUid="hotel" onComplete={done} />);
  await screen.findByText(/Original weekly count/); fireEvent.click(screen.getByRole("button", { name: "Retry saved request" }));
  await waitFor(() => expect(mocks.countRetry).toHaveBeenCalledWith("hotel"));
});
