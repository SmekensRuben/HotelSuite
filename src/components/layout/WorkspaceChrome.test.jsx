import React from "react";
import {
  fireEvent,
  act,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LayoutDashboard, Package } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorkspaceChrome from "./WorkspaceChrome";

const groups = [
  {
    label: "Workspace",
    items: [
      { to: "/dashboard", label: "Overview", icon: LayoutDashboard, end: true },
      { to: "/catalog/products", label: "Catalog Products", icon: Package },
    ],
  },
];
const show = () =>
  render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <WorkspaceChrome groups={groups} subtitle="Hotel workspace" />
    </MemoryRouter>,
  );
afterEach(() => vi.unstubAllGlobals());
describe("workspace navigation", () => {
  it("identifies the active route and preserves link destinations", () => {
    show();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("link", { name: "Catalog Products" }),
    ).toHaveAttribute("href", "/catalog/products");
  });
  it("opens an accessible mobile dialog and closes it with Escape", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Hotel Toolkit");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("closes the mobile dialog when a navigation link is followed", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("link", {
        name: "Catalog Products",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("link", { name: "Catalog Products" }),
    ).toHaveAttribute("aria-current", "page");
  });
  it("releases the mobile dialog when the desktop navigation becomes available", async () => {
    const listeners = new Set();
    const desktop = {
      matches: false,
      addEventListener: (_event, listener) => listeners.add(listener),
      removeEventListener: (_event, listener) => listeners.delete(listener),
    };
    vi.stubGlobal("matchMedia", () => desktop);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => {
      desktop.matches = true;
      listeners.forEach((listener) => listener({ matches: true }));
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
