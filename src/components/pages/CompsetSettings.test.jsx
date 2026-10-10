import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ configuration: vi.fn(), counts: vi.fn(), save: vi.fn(), configure: false, readCounts: false }));
vi.mock("../../services/firebaseQuotes", () => ({ getCompsetConfiguration: mocks.configuration, getCompetitorGroupObservationCounts: mocks.counts, saveCompsetConfiguration: mocks.save }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (_feature, action) => action === "update" ? mocks.configure : mocks.readCounts }));
import CompsetSettings from "./CompsetSettings";
const configuration = (name) => ({ settings: { ownHotelLighthouseFieldName: name }, competitors: [{ id: name, displayName: name, marketRelevanceWeight: 1, active: true }] });
beforeEach(() => { vi.clearAllMocks(); mocks.configure = false; mocks.readCounts = false; mocks.configuration.mockResolvedValue(configuration("Own")); mocks.counts.mockResolvedValue({}); mocks.save.mockResolvedValue(); });

describe("ordinary revenue compset settings", () => {
  it("loads group-quote-readable compset without requesting commercial observation counts", async () => {
    render(<CompsetSettings hotelUid="hotel-a" />);
    await waitFor(() => expect(screen.getByLabelText("Own Lighthouse field mapping")).toHaveValue("Own"));
    expect(mocks.counts).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save Compset" })).toBeDisabled();
  });
  it("recovers from failed configuration reads and permits an authorized atomic save", async () => {
    mocks.configure = true; mocks.readCounts = true;
    mocks.configuration.mockRejectedValueOnce(new Error("permission denied"));
    render(<CompsetSettings hotelUid="hotel-a" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save Compset" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save Compset" }));
    await screen.findByText("Market pricing configuration saved.");
    expect(mocks.save).toHaveBeenCalledWith("hotel-a", expect.objectContaining({ ownHotelLighthouseFieldName: "Own" }), expect.any(Array));
  });
  it("ignores an old hotel's reversed response after switching hotels", async () => {
    let finishOld;
    mocks.configuration.mockImplementation((hotelUid) => hotelUid === "hotel-a" ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve(configuration("Hotel B")));
    const { rerender } = render(<CompsetSettings hotelUid="hotel-a" />);
    rerender(<CompsetSettings hotelUid="hotel-b" />);
    await waitFor(() => expect(screen.getByLabelText("Own Lighthouse field mapping")).toHaveValue("Hotel B"));
    await act(async () => finishOld(configuration("Hotel A")));
    expect(screen.getByLabelText("Own Lighthouse field mapping")).toHaveValue("Hotel B");
  });
});
