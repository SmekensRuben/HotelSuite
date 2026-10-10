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
