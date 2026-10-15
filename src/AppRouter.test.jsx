import React from "react";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import AppRouter from "./AppRouter";

const route = vi.hoisted(() => {
  let resolve;
  return { access: "denied", imports: 0, reviewImports: 0, syncImports: 0, guards: [], loaded: new Promise((done) => { resolve = done; }), resolve: () => resolve() };
});
vi.mock("./components/shared/ProtectedRoute.jsx", () => ({ default: ({ children, feature, action }) => { route.guards.push({ feature, action }); return route.access === "allowed" ? children : <p>{route.access === "checking" ? "Checking hotel access..." : "Access denied"}</p>; } }));
vi.mock("./components/pages/ProductsPage.jsx", async () => {
  route.imports += 1;
  await route.loaded;
  return { default: () => <p>Lazy catalog page</p> };
});

vi.mock("./components/pages/SupplierAiImportReviewPage.jsx", async () => {
  const { useParams } = await import("react-router-dom");
  route.reviewImports += 1;
  return { default: () => <p>Private review for {useParams().jobId}</p> };
});
vi.mock("./components/pages/CatalogSyncPage.jsx", async () => {
  const { useLocation } = await import("react-router-dom");
  route.syncImports += 1;
  return { default: () => {
    const { pathname, search, hash } = useLocation();
    return <p>Catalog review at {pathname}{search}{hash}</p>;
  } };
});

describe("route loading boundary", () => {
  it("redirects old sync links with their context before the protected lazy catalog review", async () => {
    route.access = "denied";
    const initialEntries = ["/catalog/sync?supplierId=vendor%2Fone#review"];
    const view = render(<MemoryRouter initialEntries={initialEntries}><AppRouter /></MemoryRouter>);
    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(route.syncImports).toBe(0);
    expect(route.guards.at(-1)).toEqual({ feature: "catalogproducts", action: "read" });
    route.access = "allowed";
    view.rerender(<MemoryRouter initialEntries={initialEntries}><AppRouter /></MemoryRouter>);
    expect(await screen.findByText("Catalog review at /catalog/products/sync?supplierId=vendor%2Fone#review")).toBeInTheDocument();
    expect(route.syncImports).toBe(1);
    route.access = "denied";
  });
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
  it("opens a cold import URL after the hotel permission boundary, without treating its ID as a product", async () => {
    route.access = "denied";
    const view = render(<MemoryRouter initialEntries={["/catalog/supplier-products/imports/private-job"]}><AppRouter /></MemoryRouter>);
    expect(screen.getByText("Access denied")).toBeInTheDocument(); expect(route.reviewImports).toBe(0);
    expect(route.guards.at(-1)).toEqual({ feature: "supplierproducts", action: "read" });
    route.access = "allowed";
    view.rerender(<MemoryRouter initialEntries={["/catalog/supplier-products/imports/private-job"]}><AppRouter /></MemoryRouter>);
    expect(await screen.findByText("Private review for private-job")).toBeInTheDocument(); expect(route.reviewImports).toBe(1);
  });

});
