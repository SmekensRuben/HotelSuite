import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import PersonalAccountRoute from "./PersonalAccountRoute";

const state = vi.hoisted(() => ({ currentUser: null, authLoading: false, requireMfa: false, factors: [] }));
vi.mock("../../contexts/AuthContext", () => ({ useAuthContext: () => state }));
vi.mock("../../firebaseConfig", () => ({ authPolicy: { get requireMfa() { return state.requireMfa; } } }));
vi.mock("firebase/auth", () => ({ multiFactor: () => ({ enrolledFactors: state.factors }) }));
function LoginDestination() { const location = useLocation(); return <p>Login return: {location.state?.mcpReturn || "none"}</p>; }
function show(path = "/settings/connections") {
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/settings/connections" element={<PersonalAccountRoute><p>Personal connections</p></PersonalAccountRoute>} />
    <Route path="/mcp/authorize" element={<PersonalAccountRoute><p>Personal consent</p></PersonalAccountRoute>} />
    <Route path="/login" element={<LoginDestination />} />
  </Routes></MemoryRouter>);
}

describe("personal connection route", () => {
  beforeEach(() => { state.currentUser = { uid: "user", emailVerified: true }; state.authLoading = false; state.requireMfa = false; state.factors = []; });
  it("permits a verified account without a selected hotel or platform role", () => {
    show(); expect(screen.getByText("Personal connections")).toBeInTheDocument();
  });
  it("waits for the current identity before rendering personal grant data", () => {
    state.authLoading = true; show();
    expect(screen.getByRole("status")).toHaveTextContent("Checking account access");
    expect(screen.queryByText("Personal connections")).not.toBeInTheDocument();
  });
  it("preserves a pending consent request through the sign-in boundary", () => {
    state.currentUser = null;
    const path = `/mcp/authorize?requestId=${"a".repeat(43)}`;
    show(path); expect(screen.getByText(`Login return: ${path}`)).toBeInTheDocument();
  });
  it("requires verified email and the configured second factor", () => {
    state.currentUser.emailVerified = false;
    const view = show(); expect(screen.getByText("Login return: /settings/connections")).toBeInTheDocument();
    view.unmount(); state.currentUser.emailVerified = true; state.requireMfa = true;
    show(); expect(screen.getByText("Login return: /settings/connections")).toBeInTheDocument();
  });
});
