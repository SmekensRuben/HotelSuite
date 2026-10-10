import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { beforeEach, it, expect, vi } from "vitest";
import UserDetailPage from "./UserDetailPage";
import { getUserById, getUserMemberships, updateUserWithMemberships } from "../../services/firebaseUserManagement";

vi.mock("../../services/firebaseUserManagement", () => ({ getUserById: vi.fn(), getUserMemberships: vi.fn(), updateUserWithMemberships: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: { currentUser: { uid: "operator" } }, signOut: vi.fn() }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: () => true }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: "hotel-a" }) }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));

beforeEach(() => {
  getUserById.mockResolvedValue({ email: "member@example.test", hotelUid: ["hotel-a"], accessRevision: 7 });
  getUserMemberships.mockResolvedValue({ "hotel-a": ["orders.*", "auditUpsells.read"] });
  updateUserWithMemberships.mockResolvedValue({ accessRevision: 8 });
});

it("shows existing wildcard access and removes it explicitly while preserving the Auth-managed sign-in email", async () => {
  render(<MemoryRouter initialEntries={["/settings/users/member"]}><Routes><Route path="/settings/users/:userId" element={<UserDetailPage />} /></Routes></MemoryRouter>);
  await screen.findByText("Permissions for hotel-a");
  const orderPermissions = within(screen.getByText("orders").parentElement);
  expect(orderPermissions.getByLabelText("All actions").checked).toBe(true);
  expect(screen.getByLabelText(/Email/).readOnly).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove all permissions for this hotel" }));
  expect(orderPermissions.getByLabelText("All actions").checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await waitFor(() => expect(updateUserWithMemberships).toHaveBeenCalledWith("member", expect.objectContaining({ email: "member@example.test" }), { "hotel-a": [] }, 7));
});

it("does not permit a blank access save when the current user record is unavailable", async () => {
  getUserById.mockRejectedValueOnce(new Error("unavailable"));
  render(<MemoryRouter initialEntries={["/settings/users/member"]}><Routes><Route path="/settings/users/:userId" element={<UserDetailPage />} /></Routes></MemoryRouter>);
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Save", exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reload user access" })).toBeInTheDocument();
});
