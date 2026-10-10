import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AuthContext } from "../../contexts/AuthContext";
import PlatformRoute from "./PlatformRoute";

vi.mock("../../firebaseConfig", () => ({ authPolicy: { requireMfa: false } }));
afterEach(cleanup);
function show(values) {
  render(<AuthContext.Provider value={{ authLoading: false, currentUser: { uid: "operator", emailVerified: true }, hotelUids: [], ...values }}><MemoryRouter initialEntries={["/platform"]}><Routes>
    <Route path="/platform" element={<PlatformRoute><p>Platform console</p></PlatformRoute>} />
    <Route path="/login" element={<p>Login</p>} /><Route path="/dashboard" element={<p>Hotel workspace</p>} /><Route path="/access" element={<p>Hotel assignment needed</p>} />
  </Routes></MemoryRouter></AuthContext.Provider>);
}
it("allows a verified platform operator with no hotel assignment", () => { show({ isPlatformAdmin: true }); expect(screen.getByText("Platform console")).toBeInTheDocument(); });
it("rejects an ordinary hotel user despite their hotel assignment", () => { show({ isPlatformAdmin: false, hotelUids: ["a"] }); expect(screen.getByText("Hotel workspace")).toBeInTheDocument(); });
it("rejects an unverified platform identity", () => { show({ isPlatformAdmin: true, currentUser: { emailVerified: false } }); expect(screen.getByText("Login")).toBeInTheDocument(); });
it("waits for current authentication instead of showing platform content", () => { show({ isPlatformAdmin: true, authLoading: true }); expect(screen.getByRole("status")).toHaveTextContent("Checking platform access"); expect(screen.queryByText("Platform console")).not.toBeInTheDocument(); });
