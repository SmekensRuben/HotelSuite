import React from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ manageHotelDemoData: vi.fn() }));
vi.mock("../../services/firebasePlatform", () => ({ ...api, platformError: () => "Request unavailable" }));
import HotelDemoDataPanel from "./HotelDemoDataPanel";
const preview = { hotelUid: "test-hotel-2", datasetId: "procurement-demo-v1", businessDate: "2026-10-12", canApply: true,
  alreadyLoaded: false, summary: { catalogProducts: 12, supplierProducts: 15, suppliers: 3, outlets: 3, locations: 3, orders: 7,
    stockCounts: 3, receipts: 4, inventoryMovements: 4, approvers: 1 } };
beforeEach(() => { vi.clearAllMocks(); api.manageHotelDemoData.mockResolvedValue(preview); });
afterEach(cleanup);
const view = (hotelUid = "test-hotel-2") => render(<MemoryRouter><HotelDemoDataPanel hotelUid={hotelUid} /></MemoryRouter>);
it("never reads or writes demo data for another hotel", () => {
  view("real-hotel"); expect(api.manageHotelDemoData).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Load demo dataset" })).not.toBeInTheDocument();
});
it("previews without writing and requires the explicit fictional-data acknowledgement", async () => {
  view(); const load = await screen.findByRole("button", { name: "Load demo dataset" });
  expect(load).toBeDisabled(); expect(api.manageHotelDemoData.mock.calls).toEqual([["test-hotel-2", "preview"]]);
  expect(screen.getByText(/No supplier email or SFTP delivery is sent/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox")); expect(load).not.toBeDisabled();
  api.manageHotelDemoData.mockResolvedValue({ ...preview, alreadyLoaded: true, canApply: false });
  fireEvent.click(load); await screen.findByText(/This dataset is already loaded/);
  expect(api.manageHotelDemoData.mock.calls[1]).toEqual(["test-hotel-2", "apply"]);
  expect(api.manageHotelDemoData.mock.calls[2]).toEqual(["test-hotel-2", "preview"]);
});
it("conflicts disable writes instead of offering an overwrite/reset", async () => {
  api.manageHotelDemoData.mockResolvedValue({ ...preview, canApply: false, conflicts: ["hotels/test-hotel-2/orders/demo-v1-order-awaiting"] });
  view(); await screen.findByText(/No data will be overwritten/);
  expect(screen.getByRole("checkbox")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Load demo dataset" })).toBeDisabled();
  expect(api.manageHotelDemoData).toHaveBeenCalledTimes(1);
});
it("an uncertain apply keeps a status refresh available without claiming an empty or successful database", async () => {
  api.manageHotelDemoData.mockResolvedValueOnce(preview).mockRejectedValueOnce(new Error("timeout"));
  view(); await screen.findByRole("checkbox"); fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Load demo dataset" }));
  await screen.findByText(/an uncertain request may already have completed/);
  api.manageHotelDemoData.mockResolvedValue({ ...preview, alreadyLoaded: true, canApply: false });
  fireEvent.click(screen.getByRole("button", { name: "Refresh demo status" }));
  await screen.findByText(/Your subsequent edits are preserved/);
  await waitFor(() => expect(api.manageHotelDemoData).toHaveBeenCalledTimes(3));
});
