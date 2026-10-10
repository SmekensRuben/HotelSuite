import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import HotelOnboardingPage from "./HotelOnboardingPage";
import { createHotel, inviteHotelUser, getHotelOnboardingStatus } from "../../services/firebaseOnboarding";

vi.mock("../layout/HeaderBar", () => ({ default: () => <header>Hotel Toolkit</header> }));
vi.mock("../../firebaseConfig", () => ({ auth: {}, signOut: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ refreshHotelAssignments: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock("../../services/firebaseSubscriptions", () => ({ getHotelSubscriptions: vi.fn().mockResolvedValue([{ hotelUid: "hotel-a", hotelName: "Hotel A" }]) }));
vi.mock("../../services/firebaseOnboarding", () => ({ createHotel: vi.fn(), inviteHotelUser: vi.fn(), getHotelOnboardingStatus: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); getHotelOnboardingStatus.mockReset().mockResolvedValue({ enabled: true }); });

describe("hotel onboarding", () => {
  it("reuses an uncertain creation request and offers invitation only after successful creation", async () => {
    createHotel.mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce({ hotelUid: "hotel-c", name: "Hotel C", status: "trialing" });
    render(<MemoryRouter><HotelOnboardingPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create hotel" }).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Hotel name"), { target: { value: "Hotel C" } });
    fireEvent.change(screen.getByLabelText(/Hotel ID/), { target: { value: "hotel-c" } });
    fireEvent.click(screen.getByRole("button", { name: "Create hotel" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Create hotel" }));
    await screen.findByText("Hotel C is ready. Invite a primary and backup hotel administrator below.");
    expect(createHotel.mock.calls[0][0].requestId).toBe(createHotel.mock.calls[1][0].requestId);
    expect(createHotel.mock.calls[1][0]).toMatchObject({ status: "trialing", trialDays: 14 });
    expect(screen.getByLabelText("Hotel").value).toBe("hotel-c");
  });

  it("resends an invitation explicitly while keeping the existing hotel access", async () => {
    inviteHotelUser.mockResolvedValue({ status: "queued" });
    render(<MemoryRouter><HotelOnboardingPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText("Hotel").value).toBe("hotel-a"));
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "manager@example.test" } });
    fireEvent.click(screen.getByLabelText(/Resend an invitation to an existing member/));
    fireEvent.click(screen.getByRole("button", { name: "Resend invitation" }));
    await screen.findByText(/Their invitation is queued/);
    expect(inviteHotelUser).toHaveBeenCalledWith(expect.objectContaining({ hotelUid: "hotel-a", email: "manager@example.test", resend: true }));
  });

  it("shows pending platform activation and never submits hotel changes before it completes", async () => {
    getHotelOnboardingStatus.mockResolvedValueOnce({ enabled: false }).mockResolvedValueOnce({ enabled: true });
    render(<MemoryRouter><HotelOnboardingPage /></MemoryRouter>);
    await screen.findByText("Hotel setup is awaiting platform activation");
    expect(screen.getByRole("button", { name: "Create hotel" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create hotel" }));
    expect(createHotel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check activation again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create hotel" }).disabled).toBe(false));
  });
});
