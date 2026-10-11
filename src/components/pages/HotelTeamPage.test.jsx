import React from "react";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import HotelTeamPage from "./HotelTeamPage";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", canManage: true, getHotelTeam: vi.fn(), updateHotelMember: vi.fn(), removeHotelMember: vi.fn(), inviteHotelUser: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel, hotelName: mocks.hotel, isHotelAdmin: mocks.canManage, isPlatformAdmin: false }) }));
vi.mock("../../firebaseConfig", () => ({ auth: { currentUser: { uid: "admin" } }, signOut: vi.fn() }));
vi.mock("../../services/firebaseHotelTeam", () => ({ getHotelTeam: mocks.getHotelTeam, updateHotelMember: mocks.updateHotelMember, removeHotelMember: mocks.removeHotelMember }));
vi.mock("../../services/firebaseOnboarding", () => ({ inviteHotelUser: mocks.inviteHotelUser }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
const legacy = { id: "member", email: "member@example.test", firstName: "Existing", lastName: "Member", permissions: ["orders.read", "orders.*"], additionalPermissions: null, moduleRoles: {}, revision: 3, hotelAdmin: false };
beforeEach(() => {
  vi.resetAllMocks(); mocks.hotel = "hotel-a"; mocks.canManage = true;
  mocks.getHotelTeam.mockResolvedValue({ users: [legacy], modules: ["procurement"], seatLimit: null });
  mocks.inviteHotelUser.mockResolvedValue({ status: "queued" });
  mocks.updateHotelMember.mockResolvedValue({ revision: 4 });
  mocks.removeHotelMember.mockResolvedValue({ removed: true });
});
it("invites into the selected hotel with combined module roles and independent administration", async () => {
  render(<HotelTeamPage />);
  await screen.findByText("Existing Member");
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.test" } });
  fireEvent.click(screen.getByLabelText("Buyer"));
  fireEvent.click(screen.getByLabelText("Approver"));
  fireEvent.click(screen.getByLabelText("Hotel administrator"));
  fireEvent.click(screen.getByRole("button", { name: "Assign access and send invitation" }));
  await waitFor(() => expect(mocks.inviteHotelUser).toHaveBeenCalledWith(expect.objectContaining({ hotelUid: "hotel-a", email: "new@example.test", hotelAdmin: true, moduleRoles: { procurement: ["buyer", "approver"] } })));
  expect(mocks.inviteHotelUser.mock.calls[0][0].requestId).toBeTruthy();
});
it("preserves existing custom permissions while adding an explicit role", async () => {
  render(<HotelTeamPage />);
  fireEvent.click(await screen.findByText("Existing Member"));
  fireEvent.click(screen.getByLabelText("Stock Controller"));
  fireEvent.click(screen.getByRole("button", { name: "Save hotel access" }));
  await waitFor(() => expect(mocks.updateHotelMember).toHaveBeenCalledWith(expect.objectContaining({ hotelUid: "hotel-a", userId: "member", expectedRevision: 3, additionalPermissions: ["orders.read", "orders.*"], moduleRoles: { procurement: ["stock-controller"] } })));
});
it("requires a reviewable confirmation before removing hotel access", async () => {
  render(<HotelTeamPage />);
  fireEvent.click(await screen.findByText("Existing Member"));
  fireEvent.click(screen.getByRole("button", { name: "Remove hotel access" }));
  expect(screen.getByRole("alertdialog", { name: "Confirm hotel access removal" })).toBeInTheDocument();
  expect(mocks.removeHotelMember).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
  await waitFor(() => expect(mocks.removeHotelMember).toHaveBeenCalledWith(expect.objectContaining({ hotelUid: "hotel-a", userId: "member", expectedRevision: 3 })));
});
it("does not enumerate users without hotel-administrator authority", () => {
  mocks.canManage = false;
  render(<HotelTeamPage />);
  expect(screen.getByRole("alert")).toHaveTextContent("Hotel administrator access is required");
  expect(mocks.getHotelTeam).not.toHaveBeenCalled();
});
it("shows the rollout block without inventing an empty team or unlimited subscription", async () => {
  mocks.getHotelTeam.mockRejectedValue({ code: "functions/failed-precondition", message: "The platform operator must finish the verified SaaS Rules rollout before making this change. [400]" });
  render(<HotelTeamPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent("platform administrator completes the required security update");
  expect(screen.getByRole("status")).toHaveTextContent("Team members and subscription limits could not be loaded");
  expect(screen.queryByText(/0 assigned accounts|No user limit/)).not.toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Invite a member" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Assign access and send invitation" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refresh team" })).toBeEnabled();
  expect(mocks.inviteHotelUser).not.toHaveBeenCalled();
});
it("recovers after a failed load and distinguishes a confirmed empty team", async () => {
  mocks.getHotelTeam.mockRejectedValueOnce(new Error("The team request failed."))
    .mockResolvedValue({ users: [], modules: ["procurement"], seatLimit: 5 });
  render(<HotelTeamPage />);
  await screen.findByRole("alert");
  expect(screen.queryByText(/assigned accounts/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh team" }));
  expect(await screen.findByText(/0 assigned accounts · Limit: 5/)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Assign access and send invitation" })).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Assign access and send invitation" }));
  await waitFor(() => expect(mocks.inviteHotelUser).toHaveBeenCalledWith(expect.objectContaining({ hotelUid: "hotel-a", email: "new@example.test" })));
});
it("removes a stale team and editor when refreshing fails", async () => {
  mocks.getHotelTeam.mockResolvedValueOnce({ users: [legacy], modules: ["procurement"], seatLimit: null })
    .mockRejectedValue(new Error("Access is unavailable."));
  render(<HotelTeamPage />);
  fireEvent.click(await screen.findByText("Existing Member"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh team" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Access is unavailable.");
  expect(screen.queryByText("Existing Member")).not.toBeInTheDocument();
  expect(screen.queryByText(/assigned accounts|No user limit/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save hotel access" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Resend invitation" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Remove hotel access" })).not.toBeInTheDocument();
});
it("blocks every edit action after a mutation fails and requires a refresh", async () => {
  mocks.updateHotelMember.mockRejectedValue({ code: "functions/aborted", message: "Member changed." });
  render(<HotelTeamPage />);
  fireEvent.click(await screen.findByText("Existing Member"));
  fireEvent.click(screen.getByRole("button", { name: "Save hotel access" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("This member changed. Refresh the team");
  for (const name of ["Save hotel access", "Resend invitation", "Remove hotel access", "Invite a member", "Existing Member"]) {
    expect(screen.getByRole("button", { name })).toBeDisabled();
  }
  expect(screen.getByLabelText("Email")).toBeDisabled();
  expect(screen.getByLabelText("Buyer")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Resend invitation" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove hotel access" }));
  expect(mocks.inviteHotelUser).not.toHaveBeenCalled();
  expect(mocks.removeHotelMember).not.toHaveBeenCalled();
});
it("closes the stale editor and uses the refreshed member revision for the next save", async () => {
  mocks.getHotelTeam.mockResolvedValueOnce({ users: [legacy], modules: ["procurement"], seatLimit: null })
    .mockResolvedValue({ users: [{ ...legacy, revision: 9 }], modules: ["procurement"], seatLimit: null });
  mocks.updateHotelMember.mockRejectedValueOnce({ code: "functions/aborted" });
  render(<HotelTeamPage />);
  fireEvent.click(await screen.findByText("Existing Member"));
  fireEvent.click(screen.getByRole("button", { name: "Save hotel access" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Refresh team" }));
  await screen.findByText("Existing Member");
  expect(screen.queryByRole("button", { name: "Save hotel access" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Existing Member"));
  fireEvent.click(screen.getByRole("button", { name: "Save hotel access" }));
  await waitFor(() => expect(mocks.updateHotelMember).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 9 })));
});
it("preserves unrelated precondition errors instead of diagnosing them as a rollout block", async () => {
  mocks.removeHotelMember.mockRejectedValue({ code: "functions/failed-precondition", message: "Appoint another hotel administrator before removing the last one." });
  render(<HotelTeamPage />);
  fireEvent.click(await screen.findByText("Existing Member"));
  fireEvent.click(screen.getByRole("button", { name: "Remove hotel access" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Appoint another hotel administrator before removing the last one.");
  expect(screen.getByRole("button", { name: "Confirm removal" })).toBeDisabled();
});
it("ignores an obsolete save completion after the selected hotel changes", async () => {
  let finish;
  mocks.updateHotelMember.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const view = render(<HotelTeamPage />);
  fireEvent.click(await screen.findByText("Existing Member"));
  fireEvent.click(screen.getByRole("button", { name: "Save hotel access" }));
  await waitFor(() => expect(mocks.updateHotelMember).toHaveBeenCalledTimes(1));
  mocks.hotel = "hotel-b";
  mocks.getHotelTeam.mockResolvedValue({ users: [], modules: [], seatLimit: null });
  view.rerender(<HotelTeamPage />);
  await screen.findByText(/Manage named accounts and module roles for hotel-b/);
  await act(async () => finish({ revision: 4 }));
  expect(screen.queryByText("Hotel access updated.")).not.toBeInTheDocument();
  expect(mocks.getHotelTeam.mock.calls.filter(([hotelUid]) => hotelUid === "hotel-a")).toHaveLength(1);
  expect(screen.queryByText("Existing Member")).not.toBeInTheDocument();
});
