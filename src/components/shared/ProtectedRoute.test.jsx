import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProtectedRoute from "./ProtectedRoute";

let hotelContext;
const { authPolicy } = vi.hoisted(() => ({ authPolicy: { requireMfa: true } }));
let enrolledFactors = [{ factorId: "phone" }];

vi.mock("../../contexts/HotelContext", () => ({
  useHotelContext: () => hotelContext,
}));
vi.mock("../../firebaseConfig", () => ({
  auth: { currentUser: { emailVerified: true } },
  authPolicy,
  signOut: vi.fn(),
}));
vi.mock("firebase/auth", () => ({
  multiFactor: () => ({ enrolledFactors }),
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
    authPolicy.requireMfa = true;
    enrolledFactors = [{ factorId: "phone" }];
    hotelContext = {
      hotelUid: "hotel-a",
      hotelName: "Test Hotel",
      hotelUids: ["hotel-a"],
      retrySubscription: vi.fn(),
      selectHotel: vi.fn(),
      subscriptionActive: true,
      subscription: { modules: ["procurement", "contracts", "frontoffice", "groups", "revenue"], modulePolicyVersion: 1, status: "active", validUntil: null },
      subscriptionLoading: false,
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

  it("does not unlock an unlicensed module through wildcard permissions", () => {
    hotelContext.subscription.modules = ["procurement"];
    hotelContext.permissions = ["reservations.*"];
    renderProtected({ feature: "reservations" });
    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  it("requires hotel administrator status in addition to user permissions", () => {
    hotelContext.permissions = ["users.*"];
    hotelContext.isHotelAdmin = false;
    renderProtected({ feature: "users", hotelAdminOnly: true });
    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  it("explains missing module activation without presenting an active subscription as expired", () => {
    hotelContext.subscription = { status: "active", validUntil: null };
    renderProtected();
    expect(screen.getByRole("heading", { name: "Your hotel modules need activation" })).toBeInTheDocument();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No active hotel subscription" })).not.toBeInTheDocument();
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

  it("allows platform-only access with no selected hotel or active hotel subscription", () => {
    hotelContext = { ...hotelContext, hotelUid: null, hotelUids: [], subscription: null, subscriptionActive: false, isPlatformAdmin: true };
    renderProtected({ platformOnly: true });
    expect(screen.getByText("protected content")).toBeInTheDocument();
  });

  it("does not use platform authority to bypass operational action permissions", () => {
    hotelContext = { ...hotelContext, permissions: [], isPlatformAdmin: true };
    renderProtected({ feature: "reservations", action: "read" });
    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  it("does not require an enrolled factor when MFA is disabled", () => {
    authPolicy.requireMfa = false;
    enrolledFactors = [];
    renderProtected({ feature: "reservations", action: "read" });
    expect(screen.getByText("protected content")).toBeInTheDocument();
  });

  it("requires an enrolled factor when MFA is enabled", () => {
    enrolledFactors = [];
    renderProtected({ feature: "reservations", action: "read" });
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });

  it("blocks protected content for inactive subscriptions", () => {
    hotelContext.subscriptionActive = false;
    renderProtected({ feature: "reservations", action: "read" });
    expect(screen.getByRole("heading", { name: "No active hotel subscription" })).toBeInTheDocument();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });

  it("does not present a subscription read failure as an expired subscription", () => {
    hotelContext.subscriptionActive = false;
    hotelContext.subscriptionError = "permission-denied";
    renderProtected();
    expect(screen.getByRole("heading", { name: "We could not verify your hotel access" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No active hotel subscription" })).not.toBeInTheDocument();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check access again" }));
    expect(hotelContext.retrySubscription).toHaveBeenCalledOnce();
  });

  it("offers only other hotels assigned to the user", () => {
    hotelContext.subscriptionActive = false;
    hotelContext.hotelUids = ["hotel-a", "hotel-b"];
    renderProtected();
    fireEvent.click(screen.getByRole("button", { name: "hotel-b" }));
    expect(hotelContext.selectHotel).toHaveBeenCalledWith("hotel-b");
    expect(screen.queryByRole("button", { name: "hotel-a" })).not.toBeInTheDocument();
  });
});
