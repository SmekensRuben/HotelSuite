import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import PlatformHotelPage from "./PlatformHotelPage";

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), readiness: vi.fn() }));
vi.mock("../../services/firebasePlatform", () => ({ getPlatformHotel: api.get, updatePlatformHotel: api.save, startPlatformSupport: vi.fn(), platformError: (error) => error.message }));
vi.mock("../../services/firebaseOnboarding", () => ({ getHotelSetupReadiness: api.readiness }));
vi.mock("./HotelDemoDataPanel", () => ({ default: () => null }));
vi.mock("./PurchasingMonitoringPanel", () => ({ default: () => null }));
const dto = { hotelUid: "hotel-a", name: "Hotel A", revision: 3, timeZone: null, legacyTimeZone: null, currency: null,
  settingsFingerprint: "a".repeat(64), contactName: "", contactEmail: "", memberCount: 0, administrators: [], subscription: null };
const readiness = { status: "pending", computedAtMillis: 1, integrity: { issueCount: 0, issues: [] }, recentInvitations: [], checks: [
  { id: "property", label: "Property time zone and currency", status: "pending", detail: "Choose property settings.", required: true, action: "hotel" },
] };
beforeEach(() => { vi.clearAllMocks(); api.get.mockResolvedValue(dto); api.save.mockResolvedValue({ revision: 4 }); api.readiness.mockResolvedValue(readiness); });
function view(hash = "") { return render(<MemoryRouter initialEntries={[`/platform/hotels/hotel-a${hash}`]}><Routes><Route path="/platform/hotels/:hotelUid" element={<PlatformHotelPage />} /></Routes></MemoryRouter>); }
async function select(label, search, option) {
  const input = screen.getByRole("combobox", { name: label });
  fireEvent.focus(input); fireEvent.change(input, { target: { value: search } });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}
it("takes the checklist action to its form and focuses the searchable time zone every time", async () => {
  const scroll = vi.fn(); const original = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = scroll;
  try {
    view(); const link = await screen.findByRole("link", { name: "Manage hotel details" });
    expect(link).toHaveAttribute("href", "/platform/hotels/hotel-a#property-and-contact");
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Hotel time zone" })).toHaveFocus());
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: "start" }));
    fireEvent.click(screen.getByLabelText("Hotel name")); fireEvent.click(link);
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("combobox", { name: "Hotel time zone" })).toHaveFocus();
  } finally { Element.prototype.scrollIntoView = original; }
});
it("handles direct anchor entry after the hotel read completes", async () => {
  let resolve; api.get.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  view("#property-and-contact");
  await act(async () => resolve(dto));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Hotel time zone" })).toHaveFocus());
});
it("keeps missing settings blank and saves selected human choices with their canonical values", async () => {
  view(); await screen.findByLabelText("Hotel name");
  expect(screen.getByRole("combobox", { name: "Hotel time zone" })).toHaveValue("");
  expect(screen.getByRole("combobox", { name: "Hotel currency" })).toHaveValue("");
  await select("Hotel time zone", "Belgium", "Belgium — Brussels (Europe/Brussels)");
  await select("Hotel currency", "Euro", "EUR — Euro");
  api.get.mockResolvedValue({ ...dto, revision: 4, timeZone: "Europe/Brussels", currency: "EUR" });
  fireEvent.click(screen.getByRole("button", { name: "Save hotel details" }));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ hotelUid: "hotel-a", expectedRevision: 3,
    timeZone: "Europe/Brussels", currency: "EUR", settingsFingerprint: dto.settingsFingerprint, confirmCurrencyChange: false })));
  expect(await screen.findByText(/Hotel details saved/)).toBeInTheDocument();
});
it("requires acknowledgement for changing a known currency and never converts free text into a selection", async () => {
  api.get.mockResolvedValue({ ...dto, timeZone: "Europe/Brussels", currency: "EUR" });
  view(); await screen.findByLabelText("Hotel name");
  await select("Hotel currency", "US dollar", "USD — US Dollar");
  fireEvent.submit(screen.getByRole("button", { name: "Save hotel details" }).closest("form"));
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: /Apply this currency/ }));
  fireEvent.submit(screen.getByRole("button", { name: "Save hotel details" }).closest("form"));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ currency: "USD", confirmCurrencyChange: true })));
});
it("does not guess unknown values from typed search text and offers the legacy zone for explicit saving", async () => {
  api.get.mockResolvedValue({ ...dto, legacyTimeZone: "Europe/Brussels" }); view(); await screen.findByLabelText("Hotel name");
  expect(screen.getByText(/Save hotel details to apply it/)).toBeInTheDocument();
  const currency = screen.getByRole("combobox", { name: "Hotel currency" });
  fireEvent.change(currency, { target: { value: "Euro" } }); fireEvent.blur(currency);
  fireEvent.submit(screen.getByRole("button", { name: "Save hotel details" }).closest("form"));
  expect(api.save).not.toHaveBeenCalled(); expect(currency).toHaveValue("");
});
