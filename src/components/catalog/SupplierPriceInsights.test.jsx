import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SupplierPriceComparison, SupplierPriceHistory } from "./SupplierPriceInsights";
const mocks = vi.hoisted(() => ({ permissions: true, comparison: vi.fn(), history: vi.fn(), auth: { currentUser: { uid: "buyer" } } }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: () => mocks.permissions }));
vi.mock("../../services/firebaseSupplierInsights", () => ({ getSupplierPriceComparison: mocks.comparison, getSupplierPriceHistory: mocks.history }));
const option = (price, patch = {}) => ({ id: "default", purchaseUnit: "Case", available: true, reason: null,
  pricePerPurchaseUnit: price * 6, catalogUnitsPerPurchaseUnit: 6, netPricePerCatalogUnit: price, ...patch });
const product = (id, price, patch = {}) => ({ id, name: `Juice ${id}`, supplierName: `Supplier ${id}`, supplierSku: id, currency: "EUR", active: true,
  priceBasis: "net", sourcePriceRecordedAt: null, options: [option(price)], ...patch });
const comparison = (products, patch = {}) => ({ hotelUid: "a", mode: "comparison", policyVersion: 1, catalog: { id: "juice", baseUnit: "l" }, products, nextProductId: null, ...patch });
const history = (entries) => ({ hotelUid: "a", mode: "history", policyVersion: 1, supplierProductId: "offer", entries, nextRevision: null });
const entry = { revision: 2, observation: "terms-changed", observedAt: "2026-10-12T00:00:00Z", currency: "EUR", catalogProductId: "juice", catalogBaseUnit: "l", options: [option(2.5)],
  previous: { currency: "EUR", catalogProductId: "juice", catalogBaseUnit: "l", options: [option(2)] } };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { resolve, promise }; };
const renderComparison = (props = {}) => render(<MemoryRouter><SupplierPriceComparison hotelUid="a" catalogProductId="juice" {...props} /></MemoryRouter>);
describe("supplier price insight workflows", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.permissions = true; mocks.auth.currentUser = { uid: "buyer" }; mocks.comparison.mockResolvedValue(comparison([product("a", 2)])); mocks.history.mockResolvedValue(history([entry])); });
  it("requires all price insight permissions and does not call the backend without access", () => {
    mocks.permissions = false; renderComparison();
    expect(screen.getByText(/read permissions are required/)).toBeInTheDocument(); expect(mocks.comparison).not.toHaveBeenCalled();
  });
  it("qualifies partial rankings, loads the next bounded page and ranks zero-price offers correctly", async () => {
    mocks.comparison.mockResolvedValueOnce(comparison([product("a", 2)], { nextProductId: "a" })).mockResolvedValueOnce(comparison([product("b", 0)]));
    renderComparison(); expect(await screen.findByText("Lowest loaded goods price")).toBeInTheDocument(); expect(screen.getByText(/Comparison is incomplete/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more supplier offers" }));
    await waitFor(() => expect(mocks.comparison).toHaveBeenCalledWith("a", "juice", { afterProductId: "a" }));
    expect(await screen.findByText("Juice b")).toBeInTheDocument(); expect(screen.getAllByText("Lowest entered goods price")).toHaveLength(1);
    expect(screen.queryByText(/Comparison is incomplete/)).not.toBeInTheDocument();
  });
  it("provides practical filters and explicit unknown pricing/validity and excluded charges", async () => {
    mocks.comparison.mockResolvedValueOnce(comparison([product("known", 2), product("unknown", null, { options: [option(null, { available: false, reason: "purchase-price-unavailable", pricePerPurchaseUnit: null, catalogUnitsPerPurchaseUnit: null })] })]));
    renderComparison(); expect(await screen.findByText("Purchase price unknown")).toBeInTheDocument();
    expect(screen.getByText(/Freight, deposits, minimum order quantities/)).toBeInTheDocument(); expect(screen.getAllByText("Contractual validity unknown")).toHaveLength(2);
    fireEvent.change(screen.getByPlaceholderText("Search loaded offers"), { target: { value: "known" } });
    expect(screen.getByText("Juice known")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show offers needing price review"));
    expect(screen.queryByText("Purchase price unknown")).not.toBeInTheDocument();
  });
  it("does not reuse a default-package confirmation for an unconfirmed preserved option", async () => {
    mocks.comparison.mockResolvedValueOnce(comparison([product("offer", 2, {
      sourcePriceRecordedAt: "2026-10-14T00:00:00Z",
      options: [option(2), option(3, { id: "small", purchaseUnit: "Small case" })],
      reliability: { lastPriceChangeAt: null, lastPriceConfirmedAt: "2026-10-14T00:00:00Z", optionReliability: {
        default: { lastPriceConfirmedAt: "2026-10-14T00:00:00Z", confirmationMatchesCurrentTerms: true },
      } },
    })]));
    renderComparison();
    expect(await screen.findByText("Small case")).toBeInTheDocument();
    expect(screen.getAllByText("Changed Unknown observation date")).toHaveLength(2);
    expect(screen.getByText("Confirmed Unknown observation date")).toBeInTheDocument();
  });
  it("drops prior hotel responses on switching properties and after permission loss", async () => {
    const pending = deferred(); mocks.comparison.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(comparison([product("newhotel", 3)], { hotelUid: "b" }));
    const view = renderComparison(); await waitFor(() => expect(mocks.comparison).toHaveBeenCalledTimes(1));
    view.rerender(<MemoryRouter><SupplierPriceComparison hotelUid="b" catalogProductId="juice" /></MemoryRouter>);
    expect(await screen.findByText("Juice newhotel")).toBeInTheDocument();
    await act(async () => pending.resolve(comparison([product("oldhotel", 1)])));
    expect(screen.queryByText("Juice oldhotel")).not.toBeInTheDocument();
    mocks.permissions = false; view.rerender(<MemoryRouter><SupplierPriceComparison hotelUid="b" catalogProductId="juice" /></MemoryRouter>);
    expect(screen.queryByText("Juice newhotel")).not.toBeInTheDocument();
  });
  it("shows immutable history with actual price increases and explicit unknown historic effective dates", async () => {
    render(<SupplierPriceHistory hotelUid="a" supplierProductId="offer" />);
    expect(await screen.findByText(/above selected increase threshold/)).toHaveTextContent("+25.00%");
    expect(screen.getByText(/earlier effective date is unknown/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Highlight price increases of at least (%)"), { target: { value: "30" } });
    expect(screen.queryByText(/above selected increase threshold/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Highlight price increases of at least (%)"), { target: { value: "" } });
    expect(screen.getByText(/Highlights are unavailable/)).toBeInTheDocument();
  });
  it("restarts from page one after permission restoration and keeps partial-ranking labels accurate", async () => {
    mocks.comparison.mockResolvedValueOnce(comparison([product("a", 2)], { nextProductId: "a" }))
      .mockResolvedValueOnce(comparison([product("b", 1)]))
      .mockResolvedValueOnce(comparison([product("a", 2)], { nextProductId: "a" }));
    const view = renderComparison(); await screen.findByText("Juice a");
    fireEvent.click(screen.getByRole("button", { name: "Load more supplier offers" })); await screen.findByText("Juice b");
    mocks.permissions = false; view.rerender(<MemoryRouter><SupplierPriceComparison hotelUid="a" catalogProductId="juice" /></MemoryRouter>);
    await screen.findByText(/read permissions are required/);
    mocks.permissions = true; view.rerender(<MemoryRouter><SupplierPriceComparison hotelUid="a" catalogProductId="juice" /></MemoryRouter>);
    await screen.findByText("Juice a"); expect(screen.queryByText("Juice b")).not.toBeInTheDocument();
    expect(mocks.comparison).toHaveBeenLastCalledWith("a", "juice", { afterProductId: null });
    expect(screen.getByText("Lowest loaded goods price")).toBeInTheDocument();
    expect(screen.getByText(/Comparison is incomplete/)).toBeInTheDocument();
  });
  it("resets settled accumulated offers when the authenticated actor changes", async () => {
    const view = renderComparison(); await screen.findByText("Juice a");
    mocks.auth.currentUser = { uid: "other" }; mocks.comparison.mockResolvedValueOnce(comparison([product("actor2", 3)]));
    view.rerender(<MemoryRouter><SupplierPriceComparison hotelUid="a" catalogProductId="juice" /></MemoryRouter>);
    expect(screen.queryByText("Juice a")).not.toBeInTheDocument(); await screen.findByText("Juice actor2");
  });
  it("restarts pagination when the hotel calendar assessment changes instead of mixing yesterday's eligibility with today's", async () => {
    const old = { assessmentDate: "2026-10-12", timeZone: "Europe/Brussels" }, current = { assessmentDate: "2026-10-13", timeZone: "Europe/Brussels" };
    mocks.comparison.mockResolvedValueOnce(comparison([product("oldcheap", 1)], { ...old, nextProductId: "oldcheap" }))
      .mockResolvedValueOnce(comparison([product("laterpage", 3)], current))
      .mockResolvedValueOnce(comparison([product("newfirstpage", 2)], current));
    renderComparison(); await screen.findByText("Juice oldcheap");
    fireEvent.click(screen.getByRole("button", { name: "Load more supplier offers" }));
    expect(await screen.findByText("Juice newfirstpage")).toBeInTheDocument();
    expect(screen.queryByText("Juice oldcheap")).not.toBeInTheDocument(); expect(screen.queryByText("Juice laterpage")).not.toBeInTheDocument();
    expect(mocks.comparison).toHaveBeenLastCalledWith("a", "juice", { afterProductId: null });
    expect(screen.getByText(/comparison restarted from the first page/)).toBeInTheDocument();
  });
  it("does not invent historic events for existing products and exposes retryable errors", async () => {
    mocks.history.mockRejectedValueOnce(new Error("Request failed")).mockResolvedValueOnce(history([]));
    render(<SupplierPriceHistory hotelUid="a" supplierProductId="offer" />);
    expect(await screen.findByText(/Could not load supplier price history/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText(/No recorded price-content events yet/)).toBeInTheDocument();
  });
});

it("distinguishes economic changes, genuine confirmations and approved future periods", async () => {
  mocks.permissions = true;
  mocks.history.mockResolvedValue({ ...history([{ ...entry, observation: "price-confirmed", priceChanged: false, sourceReference: "October.csv", sourceIssuedOn: "2026-10-14" }]),
    reliability: { lastPriceChangeAt: "2026-10-01T00:00:00Z", lastPriceConfirmedAt: "2026-10-14T00:00:00Z", sourceReference: "October.csv", sourceIssuedOn: "2026-10-14", pricingDateBasis: "delivery-date", pricingAgreementKnown: true, needsReview: false, reasons: [], hasScheduledVersions: true },
    versions: [{ id: "future", revision: 3, observation: "approved", approvedAt: "2026-10-14T00:00:00Z", priceValidity: "future", contractualValidFrom: "2026-11-01", contractualValidUntil: null, currency: "EUR", catalogBaseUnit: "l", options: [option(3)], sourceReference: "November.csv", sourceIssuedOn: "2026-10-14" }] });
  render(<SupplierPriceHistory hotelUid="a" supplierProductId="offer" />);
  expect(await screen.findByText("Scheduled price")).toBeInTheDocument();
  expect(screen.getByText("Last price change")).toBeInTheDocument();
  expect(screen.getByText("Last source-backed price confirmation")).toBeInTheDocument();
  expect(screen.getByText("Delivery date")).toBeInTheDocument();
  expect(screen.getByText("Price confirmed · unchanged terms")).toBeInTheDocument();
  expect(screen.getByText(/From 2026-11-01/)).toBeInTheDocument();
});
