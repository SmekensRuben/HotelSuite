import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LayoutDashboard, Package } from "lucide-react";
import { describe, expect, it } from "vitest";
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
});
