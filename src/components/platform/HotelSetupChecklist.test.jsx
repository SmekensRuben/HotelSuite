import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import HotelSetupChecklist from "./HotelSetupChecklist";
import { getHotelSetupReadiness } from "../../services/firebaseOnboarding";

vi.mock("../../services/firebaseOnboarding", () => ({ getHotelSetupReadiness: vi.fn() }));
const report = (hotelUid, status = "ready") => ({ hotelUid, status, schemaVersion: 1, computedAtMillis: 1,
  checks: [{ id: "integrity", label: `Account check ${hotelUid}`, status, detail: "Current account evidence.", required: true, action: "team" }],
  integrity: { issueCount: 0, issues: [] }, recentInvitations: [] });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const view = (hotelUid, refreshKey = 0) => <MemoryRouter><HotelSetupChecklist hotelUid={hotelUid} refreshKey={refreshKey} /></MemoryRouter>;
beforeEach(() => { vi.resetAllMocks(); });
it("shows a dated unknown assessment and explicit orphan findings without an automatic repair", async () => {
  const data = report("hotel-a", "unknown");
  data.integrity = { issueCount: 1, issues: [{ uid: "deleted-user", codes: ["auth-account-missing", "profile-missing"] }] };
  getHotelSetupReadiness.mockResolvedValue(data);
  render(view("hotel-a"));
  expect(await screen.findByText("Account check hotel-a")).toBeInTheDocument();
  expect(screen.getByText("Account records need review")).toBeInTheDocument();
  expect(screen.getByText(/auth account missing, profile missing/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Manage team" })).toHaveAttribute("href", "/platform/hotels/hotel-a/team");
  expect(screen.queryByRole("button", { name: /repair|delete/i })).not.toBeInTheDocument();
});
it("a failed report never becomes ready and can be retried", async () => {
  getHotelSetupReadiness.mockRejectedValueOnce(new Error("Read failed")).mockResolvedValue(report("hotel-a"));
  render(view("hotel-a"));
  await screen.findByRole("alert");
  expect(screen.queryByText("ready")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Account check hotel-a")).toBeInTheDocument();
});
it("ignores a previous hotel's late ready response", async () => {
  const old = deferred();
  getHotelSetupReadiness.mockReturnValueOnce(old.promise).mockResolvedValueOnce(report("hotel-b", "blocked"));
  const mounted = render(view("hotel-a"));
  mounted.rerender(view("hotel-b"));
  await screen.findByText("Account check hotel-b");
  await act(async () => old.resolve(report("hotel-a")));
  expect(screen.queryByText("Account check hotel-a")).not.toBeInTheDocument();
  expect(screen.queryByText("ready")).not.toBeInTheDocument();
});
it("creation/invitation refresh discards the old assessment before loading the next one", async () => {
  const fresh = deferred();
  getHotelSetupReadiness.mockResolvedValueOnce(report("hotel-a")).mockReturnValueOnce(fresh.promise);
  const mounted = render(view("hotel-a"));
  await screen.findByText("Account check hotel-a");
  mounted.rerender(view("hotel-a", 1));
  expect(screen.queryByText("ready")).not.toBeInTheDocument();
  expect(screen.getByText("Loading platform data...")).toBeInTheDocument();
  await act(async () => fresh.resolve(report("hotel-a", "blocked")));
  expect(screen.getAllByText("blocked")).toHaveLength(2);
});
