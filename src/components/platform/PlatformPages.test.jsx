import React from "react";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Link } from "react-router-dom";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import PlatformImportsPage from "./PlatformImportsPage";
import PlatformHotelPage from "./PlatformHotelPage";
import PlatformSupportPage from "./PlatformSupportPage";
import PlatformIncidentsPage from "./PlatformIncidentsPage";

const api = vi.hoisted(() => Object.fromEntries(["listPlatformHotels", "getPlatformHotel", "getPlatformMonitoring", "retryPlatformImport", "savePlatformImportMonitor", "refreshPlatformMonitoring", "startPlatformSupport", "getPlatformSupport", "endPlatformSupport", "listPlatformIncidents", "acknowledgePlatformIncident"].map((name) => [name, vi.fn()])));
vi.mock("../../services/firebasePlatform", () => ({ ...api, platformError: () => "Platform request unavailable" }));
const hotel = (id) => ({ hotelUid: id, name: `Hotel ${id}`, revision: 0, timeZone: null, contactName: "", contactEmail: "", administrators: [], memberCount: 0, subscription: null });
const monitoring = { computedAtMillis: Date.now(), monitors: [{ id: "arrivals", label: "Daily arrivals", fileType: "arrivals", sourceEnabled: true, policy: null, health: { status: "not-configured", run: null, deadlineMillis: null, expectedBusinessDate: null } }], observations: [], recoveries: [] };
beforeEach(() => {
  vi.clearAllMocks(); api.listPlatformHotels.mockResolvedValue({ hotels: [], nextCursor: null });
  api.getPlatformHotel.mockImplementation(async (id) => hotel(id));
  api.getPlatformMonitoring.mockResolvedValue(monitoring);
  api.listPlatformIncidents.mockResolvedValue({ incidents: [], nextCursor: null });
});
afterEach(cleanup);
function imports() { render(<MemoryRouter initialEntries={["/platform/hotels/a/imports"]}><Routes><Route path="/platform/hotels/:hotelUid/imports" element={<PlatformImportsPage />} /></Routes></MemoryRouter>); }

it("keeps an unset delivery schedule and unavailable counts explicit without automatically saving defaults", async () => {
  imports(); await screen.findByText("Hotel a");
  expect(screen.getByText("not configured")).toBeInTheDocument();
  expect(screen.getByText("Written records: Unknown")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Configure expected delivery"));
  expect(screen.getByLabelText("IANA time zone").value).toBe("");
  expect(api.savePlatformImportMonitor).not.toHaveBeenCalled();
});

it("shows an unavailable analysis when a platform read fails, without displaying a successful empty history", async () => {
  api.getPlatformMonitoring.mockRejectedValueOnce(new Error("unavailable"));
  imports(); await screen.findByRole("alert");
  expect(screen.queryByText("No import observations are available.")).not.toBeInTheDocument();
  expect(screen.queryByText("healthy")).not.toBeInTheDocument();
});

it("keeps the same recovery request after an uncertain response and locks the original reason", async () => {
  api.getPlatformMonitoring.mockResolvedValue({ ...monitoring, observations: [{ runId: "failed-run", fileType: "arrivals", status: "failed", retryable: true, writtenCount: null }] });
  api.retryPlatformImport.mockRejectedValueOnce(new Error("network timeout")).mockResolvedValueOnce({ state: "running" });
  imports(); await screen.findByText("Review and resume");
  fireEvent.click(screen.getByText("Review and resume"));
  fireEvent.change(screen.getByLabelText("Recovery reason"), { target: { value: "Source fixed" } });
  fireEvent.click(screen.getByRole("button", { name: "Resume import" }));
  await screen.findByText("Platform request unavailable");
  expect(screen.getByLabelText("Recovery reason")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Resume import" }));
  await waitFor(() => expect(api.retryPlatformImport).toHaveBeenCalledTimes(2));
  expect(api.retryPlatformImport.mock.calls[0][0]).toEqual(api.retryPlatformImport.mock.calls[1][0]);
  expect(api.retryPlatformImport.mock.calls[0][0].hotelUid).toBe("a");
});

it("does not navigate to an earlier hotel's support session after the operator changes hotel", async () => {
  let resolve;
  api.startPlatformSupport.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  render(<MemoryRouter initialEntries={["/platform/hotels/a"]}><Link to="/platform/hotels/b">Change hotel</Link><Routes><Route path="/platform/hotels/:hotelUid" element={<PlatformHotelPage />} /><Route path="/platform/hotels/:hotelUid/support/:sessionId" element={<p>Stale support view</p>} /></Routes></MemoryRouter>);
  await screen.findByRole("heading", { name: "Hotel a" });
  fireEvent.change(screen.getByLabelText("Support reason"), { target: { value: "Inspect import" } });
  fireEvent.click(screen.getByRole("button", { name: "Start read-only support" }));
  fireEvent.click(screen.getByText("Change hotel"));
  await screen.findByRole("heading", { name: "Hotel b" });
  await act(async () => resolve({ sessionId: "old-session" }));
  expect(screen.queryByText("Stale support view")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Hotel b" })).toBeInTheDocument();
});

it("hides expired diagnostic content and offers no hotel mutation or automatic resend in support", async () => {
  api.getPlatformSupport.mockResolvedValue({ hotel: hotel("a"), monitoring, mail: { inspected: 0, statuses: {} }, scheduledDeliveries: { inspected: 0, statuses: {} }, session: { expiresAtMillis: Date.now() - 1, reason: "Inspect imports" } });
  render(<MemoryRouter initialEntries={["/platform/hotels/a/support/s"]}><Routes><Route path="/platform/hotels/:hotelUid/support/:sessionId" element={<PlatformSupportPage />} /></Routes></MemoryRouter>);
  await screen.findByText("Support session expired");
  expect(screen.queryByText("Import health")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /resume|resend|impersonate/i })).not.toBeInTheDocument();
});

it("acknowledges an incident without claiming the underlying import is healed", async () => {
  const incident = { id: "incident", hotelUid: "a", code: "overdue", state: "open", firstDetectedAtMillis: Date.now(), lastDetectedAtMillis: Date.now() };
  api.listPlatformIncidents.mockResolvedValueOnce({ incidents: [incident] }).mockResolvedValue({ incidents: [{ ...incident, acknowledgedAtMillis: Date.now() }] });
  api.acknowledgePlatformIncident.mockResolvedValue({ acknowledged: true });
  render(<MemoryRouter><PlatformIncidentsPage /></MemoryRouter>);
  await screen.findByLabelText("Review note");
  fireEvent.change(screen.getByLabelText("Review note"), { target: { value: "Investigating source" } });
  fireEvent.click(screen.getByRole("button", { name: "Acknowledge incident" }));
  await screen.findByText(/underlying issue remains open/);
  expect(screen.getByText("open")).toBeInTheDocument();
});
