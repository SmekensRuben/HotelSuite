import React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PlatformIncidentsPage from "./PlatformIncidentsPage";
import PurchasingMonitoringPanel from "./PurchasingMonitoringPanel";

const api = vi.hoisted(() => ({ listPlatformIncidents: vi.fn(), acknowledgePlatformIncident: vi.fn(), resolvePlatformWorkflowIncident: vi.fn(), getPlatformPurchasingMonitoring: vi.fn() }));
vi.mock("../../services/firebasePlatform", () => ({ ...api, platformError: () => "Monitoring unavailable" }));
const now = Date.now();
const incident = { id: "incident-a", hotelUid: "hotel-a", environment: "staging", process: "dispatches", severity: "critical", code: "delivery-unknown", state: "open",
  summary: "Order outcome needs reconciliation", nextStep: "Review the original delivery receipt before recovery.", sourceId: "dispatch-a", correlationId: "correlation-a", firstDetectedAtMillis: now - 1000, lastDetectedAtMillis: now, evidenceAtMillis: now - 2000 };
const monitoring = { environment: "staging", enabled: true, status: "stale", lastAttemptAtMillis: now, lastSuccessfulAtMillis: now - 3600000, failedHotels: 1 };
beforeEach(() => { vi.clearAllMocks(); api.listPlatformIncidents.mockResolvedValue({ incidents: [incident], monitoring, nextCursor: null }); });
afterEach(cleanup);

it("shows evaluator failure, simulation limits, evidence and a safe internal diagnostic link", async () => {
  render(<MemoryRouter><PlatformIncidentsPage /></MemoryRouter>);
  await screen.findByText(incident.summary);
  expect(screen.getByText(/Current monitoring coverage is not verified/)).toBeInTheDocument();
  expect(screen.getByText(/Staging simulations do not establish production delivery/)).toBeInTheDocument();
  expect(screen.getByText(incident.nextStep)).toBeInTheDocument();
  expect(screen.getByText("dispatch-a · correlation-a")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Review hotel diagnostics" }).getAttribute("href")).toBe("/platform/hotels/hotel-a#purchasing-monitoring");
  expect(screen.queryByRole("button", { name: /retry|resend|recover order|send mail/i })).not.toBeInTheDocument();
});

it("filters the visible page and retains explicit unknown coverage for empty incident results", async () => {
  render(<MemoryRouter><PlatformIncidentsPage /></MemoryRouter>);
  await screen.findByText(incident.summary);
  fireEvent.change(screen.getByLabelText("Severity on this page"), { target: { value: "warning" } });
  expect(screen.queryByText(incident.summary)).not.toBeInTheDocument();
  expect(screen.getByText(/No matching incidents on this page/)).toBeInTheDocument();
  expect(screen.getByText(/Current monitoring coverage is not verified/)).toBeInTheDocument();
});

it("does not render a supplied external source URL or an invalid hotel ID as a navigation target", async () => {
  api.listPlatformIncidents.mockResolvedValue({ incidents: [{ ...incident, hotelUid: "https://untrusted.invalid", sourceUrl: "https://untrusted.invalid/order" }] });
  render(<MemoryRouter><PlatformIncidentsPage /></MemoryRouter>);
  await screen.findByText(incident.summary);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("presents per-hotel bounded coverage without treating an incomplete source as healthy", async () => {
  api.getPlatformPurchasingMonitoring.mockResolvedValue({ hotelUid: "hotel-a", monitoring,
    health: { status: "unknown", computedAtMillis: now, coverage: [{ process: "mail-queue", status: "unknown", inspected: 50, truncated: true }] } });
  render(<MemoryRouter><PurchasingMonitoringPanel hotelUid="hotel-a" /></MemoryRouter>);
  await screen.findByText(/50 records inspected/);
  expect(screen.getByText(/More records require evaluation/)).toBeInTheDocument();
  expect(api.getPlatformPurchasingMonitoring).toHaveBeenCalledWith("hotel-a");
  expect(within(screen.getByRole("list")).getByText("unknown")).toBeInTheDocument();
  expect(screen.getByRole("link").getAttribute("href")).toBe("/platform/incidents");
});

it("keeps manual workflow closure separate from acknowledgment and actual business recovery", async () => {
  const workflow = { ...incident, process: "workflow", code: "unexpected-workflow-error", acknowledgedAtMillis: now };
  api.listPlatformIncidents.mockResolvedValueOnce({ incidents: [workflow], monitoring }).mockResolvedValue({ incidents: [{ ...workflow, state: "resolved", resolvedAtMillis: now, resolutionMode: "operator-review" }], monitoring });
  api.resolvePlatformWorkflowIncident.mockResolvedValue({ resolved: true, resolutionMode: "operator-review" });
  render(<MemoryRouter><PlatformIncidentsPage /></MemoryRouter>);
  await screen.findByRole("button", { name: "Close reviewed workflow alert" });
  expect(screen.getByText(/Closing it does not establish that an order/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Review outcome"), { target: { value: "Persisted outcome reviewed through authorized hotel operator" } });
  fireEvent.click(screen.getByRole("button", { name: "Close reviewed workflow alert" }));
  await screen.findByText(/No matching incidents on this page/);
  expect(api.resolvePlatformWorkflowIncident).toHaveBeenCalledWith(workflow.id, workflow.lastDetectedAtMillis, "Persisted outcome reviewed through authorized hotel operator");
  expect(api.acknowledgePlatformIncident).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByText(/Closed after operator review/)).toBeInTheDocument();
  expect(screen.queryByText(/Recovered:/)).not.toBeInTheDocument();
});
