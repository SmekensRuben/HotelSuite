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
vi.mock("../platform/HotelSetupChecklist", () => ({ default: ({ hotelUid }) => <section>Setup assessment for {hotelUid}</section> }));
beforeEach(() => { vi.clearAllMocks(); createHotel.mockReset(); inviteHotelUser.mockReset(); getHotelOnboardingStatus.mockReset().mockResolvedValue({ enabled: true }); });

async function select(label, search, option) {
  const input = screen.getByRole("combobox", { name: label });
  fireEvent.focus(input); fireEvent.change(input, { target: { value: search } });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}
async function prepareCreation() {
  render(<MemoryRouter><HotelOnboardingPage /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Create hotel" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Hotel name"), { target: { value: "Hotel C" } });
  fireEvent.change(screen.getByLabelText(/Hotel ID/), { target: { value: "hotel-c" } });
}

describe("hotel onboarding", () => {
  it("reuses an uncertain creation request and offers invitation only after successful creation", async () => {
    createHotel.mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce({ hotelUid: "hotel-c", name: "Hotel C", status: "trialing" });
    await prepareCreation();
    await select("Hotel time zone", "Belgium", "Belgium — Brussels (Europe/Brussels)");
    await select("Hotel currency", "Euro", "EUR — Euro");
    fireEvent.click(screen.getByRole("button", { name: "Create hotel" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Create hotel" }));
    await screen.findByText("Hotel C was created. Invite its administrators and complete the setup checklist.");
    expect(createHotel.mock.calls[0][0].requestId).toBe(createHotel.mock.calls[1][0].requestId);
    expect(createHotel.mock.calls[1][0]).toMatchObject({ status: "trialing", trialDays: 14, timeZone: "Europe/Brussels", currency: "EUR" });
    expect(screen.getByRole("combobox", { name: "Hotel time zone" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Hotel currency" })).toHaveValue("");
    expect(screen.queryByText(/Hotel C is ready/)).not.toBeInTheDocument();
    expect(screen.getByText("Setup assessment for hotel-c")).toBeInTheDocument();
    expect(screen.getByLabelText("Hotel").value).toBe("hotel-c");
  });

  it("requires explicit choices and never treats typed searches as property settings", async () => {
    await prepareCreation();
    const button = screen.getByRole("button", { name: "Create hotel" });
    const zone = screen.getByRole("combobox", { name: "Hotel time zone" });
    const currency = screen.getByRole("combobox", { name: "Hotel currency" });
    expect(zone).toHaveValue(""); expect(currency).toHaveValue("");
    fireEvent.change(zone, { target: { value: "Europe/Brussels" } });
    fireEvent.change(currency, { target: { value: "EUR" } });
    fireEvent.submit(button.closest("form"));
    expect(createHotel).not.toHaveBeenCalled();
    fireEvent.blur(zone); fireEvent.blur(currency);
    expect(zone).toHaveValue(""); expect(currency).toHaveValue("");
    await select("Hotel time zone", "Belgium", "Belgium — Brussels (Europe/Brussels)");
    fireEvent.submit(button.closest("form"));
    expect(createHotel).not.toHaveBeenCalled();
  });

  it("uses a new idempotency request when selected currency changes after an uncertain attempt", async () => {
    createHotel.mockRejectedValue(new Error("Connection lost"));
    await prepareCreation();
    await select("Hotel time zone", "Belgium", "Belgium — Brussels (Europe/Brussels)");
    await select("Hotel currency", "Euro", "EUR — Euro");
    fireEvent.click(screen.getByRole("button", { name: "Create hotel" }));
    await screen.findByRole("alert");
    await select("Hotel currency", "US Dollar", "USD — US Dollar");
    fireEvent.click(screen.getByRole("button", { name: "Create hotel" }));
    await waitFor(() => expect(createHotel).toHaveBeenCalledTimes(2));
    expect(createHotel.mock.calls[1][0]).toMatchObject({ timeZone: "Europe/Brussels", currency: "USD" });
    expect(createHotel.mock.calls[1][0].requestId).not.toBe(createHotel.mock.calls[0][0].requestId);
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
