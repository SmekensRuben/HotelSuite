import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SubscriptionsPage from "./SubscriptionsPage";
const { getHotelSubscriptions, saveHotelSubscription } = vi.hoisted(() => ({ getHotelSubscriptions: vi.fn(), saveHotelSubscription: vi.fn() }));
vi.mock("../../services/firebaseSubscriptions", () => ({ getHotelSubscriptions, saveHotelSubscription }));
vi.mock("../../firebaseConfig", () => ({ auth: {}, signOut: vi.fn() }));
vi.mock("../layout/HeaderBar", () => ({ default: () => <header>Hotel Toolkit</header> }));
const hotel = { hotelUid: "testhotel", hotelName: "Test Hotel", subscription: null };

describe("hotel subscription administration", () => {
  beforeEach(() => { getHotelSubscriptions.mockReset(); saveHotelSubscription.mockReset(); });
  it("distinguishes a load failure from an empty hotel list and can retry", async () => {
    getHotelSubscriptions.mockRejectedValueOnce({ code: "permission-denied" }).mockResolvedValueOnce([hotel]);
    render(<SubscriptionsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Hotel overview unavailable");
    expect(screen.queryByText("No hotels available yet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh overview" }));
    expect(await screen.findByRole("button", { name: "Save subscription" })).toBeEnabled();
  });
  it("retains hotels but prevents saving when subscription revisions cannot be read", async () => {
    getHotelSubscriptions.mockRejectedValue({ code: "permission-denied", hotelRecords: [hotel] });
    render(<SubscriptionsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Subscription setup required");
    expect(screen.getByRole("button", { name: /Test Hotel/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save subscription" })).not.toBeInTheDocument();
    expect(screen.queryByText("No hotels available yet")).not.toBeInTheDocument();
  });
  it("activates a hotel without a charge and preserves the expected revision", async () => {
    getHotelSubscriptions.mockResolvedValue([hotel]); saveHotelSubscription.mockResolvedValue({ revision: 1 });
    render(<SubscriptionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Save subscription" }));
    await waitFor(() => expect(saveHotelSubscription).toHaveBeenCalledWith({ hotelUid: "testhotel", status: "active", planId: "standard", validUntil: null, expectedRevision: 0 }));
    expect(await screen.findByText("Subscription saved. Hotel access has been updated.")).toBeInTheDocument();
  });
  it("explains an undeployed activation function", async () => {
    getHotelSubscriptions.mockResolvedValue([hotel]); saveHotelSubscription.mockRejectedValue({ code: "functions/not-found" });
    render(<SubscriptionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Save subscription" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("complete the Firebase Functions setup");
  });
});
