import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import LandingPage from "./LandingPage";
import landing from "../../locales/en/landing.json";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key) =>
      key.split(".").reduce((value, part) => value?.[part], landing) || key,
  }),
}));
const show = () =>
  render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );
afterEach(() => vi.unstubAllEnvs());

describe("public product presentation", () => {
  it("offers a usable local preview without inventing a sales contact or price", () => {
    vi.stubEnv("VITE_PUBLIC_DEMO_URL", "");
    vi.stubEnv("VITE_PUBLIC_CONTACT_EMAIL", "");
    show();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Your hotel.",
    );
    expect(screen.getByText("Demo data")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /Book a demo/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: /View product preview/ })[0],
    ).toHaveAttribute("href", "#preview");
    expect(
      screen.queryByText(/€149|guaranteed profit|create an account/i),
    ).not.toBeInTheDocument();
  });
  it("changes the isolated fictional preview when another module is selected", () => {
    show();
    const preview = screen.getByLabelText(
      "Interactive product preview with fictional data",
    );
    fireEvent.click(within(preview).getByRole("button", { name: "Groups" }));
    expect(
      within(preview).getByRole("button", { name: "Groups" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(preview).getByText("Sample conference")).toBeVisible();
    expect(within(preview).queryByText("PO-1042")).not.toBeInTheDocument();
  });
  it("connects demo actions to the explicitly configured contact", () => {
    vi.stubEnv("VITE_PUBLIC_CONTACT_EMAIL", "demo@example.com");
    show();
    for (const link of screen.getAllByRole("link", { name: /Book a demo/ }))
      expect(link).toHaveAttribute(
        "href",
        "mailto:demo@example.com?subject=Hotel%20Toolkit%20demo",
      );
  });
});
