import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProtectedRoute from "./ProtectedRoute";

let hotelContext;

vi.mock("../../contexts/HotelContext", () => ({
  useHotelContext: () => hotelContext,
}));
vi.mock("../../firebaseConfig", () => ({
  auth: { currentUser: { emailVerified: true } },
}));
vi.mock("firebase/auth", () => ({
  multiFactor: () => ({ enrolledFactors: [{ factorId: "phone" }] }),
}));

function renderProtected(props = {}) {
  render(
    <MemoryRouter initialEntries={["/protected"]}>
      <Routes>
        <Route path="/dashboard" element={<p>dashboard</p>} />
        <Route path="/protected" element={<ProtectedRoute {...props}><p>protected content</p></ProtectedRoute>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProtectedRoute permissions", () => {
  beforeEach(() => {
    hotelContext = {
      hotelUid: "hotel-a",
      loading: false,
      permissionsLoading: false,
      permissions: ["reservations.read"],
      isPlatformAdmin: false,
    };
  });

  it("allows direct route access with the selected hotel's permission", () => {
    renderProtected({ feature: "reservations", action: "read" });
    expect(screen.getByText("protected content")).toBeInTheDocument();
  });

  it("rejects direct route access without the action permission", () => {
    renderProtected({ feature: "reservations", action: "update" });
    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  it("requires a platform claim for platform-only routes", () => {
    renderProtected({ platformOnly: true });
    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  it("allows a platform administrator independently of hotel permissions", () => {
    hotelContext = { ...hotelContext, permissions: [], isPlatformAdmin: true };
    renderProtected({ platformOnly: true, feature: "users", action: "update" });
    expect(screen.getByText("protected content")).toBeInTheDocument();
  });

  it("allows a hotel super administrator to open every hotel feature route", () => {
    hotelContext = { ...hotelContext, permissions: ["super.admin"] };
    renderProtected({ feature: "reservations", action: "read" });
    expect(screen.getByText("protected content")).toBeInTheDocument();
  });
});
