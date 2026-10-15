import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import PurchaseRequestRoute from "./PurchaseRequestRoute";

const mocks = vi.hoisted(() => ({ context: {}, actor: { uid: "buyer", emailVerified: true }, guard: vi.fn(), selectHotel: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => mocks.context }));
vi.mock("../../firebaseConfig", () => ({ auth: { get currentUser() { return mocks.actor; } }, authPolicy: { requireMfa: false } }));
vi.mock("./ProtectedRoute", () => ({ default: ({ children, feature, action }) => { mocks.guard({ feature, action }); return children; } }));
function LoginContext() { return <p>Sign in for {useLocation().state?.purchaseRequestReturn}</p>; }
const show = () => <MemoryRouter initialEntries={["/purchase-requests/request-one?hotel=hotel-b"]}><Routes>
  <Route path="/purchase-requests/:id" element={<PurchaseRequestRoute><p>Private request</p></PurchaseRequestRoute>} />
  <Route path="/login" element={<LoginContext />} />
</Routes></MemoryRouter>;
beforeEach(() => {
  vi.clearAllMocks(); mocks.actor = { uid: "buyer", emailVerified: true };
  mocks.context = { hotelUid: "hotel-a", hotelUids: ["hotel-a", "hotel-b"], loading: false, selectHotel: mocks.selectHotel };
  mocks.selectHotel.mockResolvedValue(undefined);
});
it("preserves the entire request email destination before a signed-out user logs in", () => {
  mocks.actor = null; render(show());
  expect(screen.getByText("Sign in for /purchase-requests/request-one?hotel=hotel-b")).toBeInTheDocument();
  expect(mocks.guard).not.toHaveBeenCalled();
});
it("mounts no private content until the user selects the assigned hotel and reaches its permission gate", async () => {
  const view = render(show());
  expect(screen.queryByText("Private request")).not.toBeInTheDocument();
  expect(mocks.guard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Switch hotel and open request" }));
  await waitFor(() => expect(mocks.selectHotel).toHaveBeenCalledWith("hotel-b"));
  mocks.context = { ...mocks.context, hotelUid: "hotel-b" }; view.rerender(show());
  expect(screen.getByText("Private request")).toBeInTheDocument();
  expect(mocks.guard).toHaveBeenLastCalledWith({ feature: "purchaserequests", action: "read" });
});
it("does not treat a link's hotel ID as membership or grant platform administrators hotel access", () => {
  mocks.context = { ...mocks.context, hotelUids: ["hotel-a"], isPlatformAdmin: true }; render(show());
  expect(screen.getByRole("alert")).toHaveTextContent("not assigned");
  expect(screen.queryByRole("button", { name: "Switch hotel and open request" })).not.toBeInTheDocument();
  expect(screen.queryByText("Private request")).not.toBeInTheDocument();
});
