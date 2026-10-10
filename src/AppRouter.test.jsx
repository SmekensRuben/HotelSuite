import React from "react";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import AppRouter from "./AppRouter";

const route = vi.hoisted(() => {
  let resolve;
  return { access: "denied", imports: 0, loaded: new Promise((done) => { resolve = done; }), resolve: () => resolve() };
});
vi.mock("./components/shared/ProtectedRoute.jsx", () => ({ default: ({ children }) => route.access === "allowed" ? children : <p>{route.access === "checking" ? "Checking hotel access..." : "Access denied"}</p> }));
vi.mock("./components/pages/ProductsPage.jsx", async () => {
  route.imports += 1;
  await route.loaded;
  return { default: () => <p>Lazy catalog page</p> };
});

describe("route loading boundary", () => {
  it("loads a requested route only after hotel/auth checks and shows the suspense state", async () => {
    const view = render(<MemoryRouter initialEntries={["/catalog/products"]}><AppRouter /></MemoryRouter>);
    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(route.imports).toBe(0);
    route.access = "checking";
    view.rerender(<MemoryRouter initialEntries={["/catalog/products"]}><AppRouter /></MemoryRouter>);
    expect(screen.getByText("Checking hotel access...")).toBeInTheDocument();
    expect(route.imports).toBe(0);
    route.access = "allowed";
    view.rerender(<MemoryRouter initialEntries={["/catalog/products"]}><AppRouter /></MemoryRouter>);
    expect(screen.getByText("Loading page...")).toBeInTheDocument();
    await act(async () => route.resolve());
    expect(await screen.findByText("Lazy catalog page")).toBeInTheDocument();
    expect(route.imports).toBe(1);
  });
});
