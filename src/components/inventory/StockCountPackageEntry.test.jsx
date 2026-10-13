// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({ getOptions: vi.fn() }));
vi.mock("../../firebaseConfig", () => ({ auth: { currentUser: { uid: "counter" } } }));
vi.mock("../../services/firebaseStockCounts", () => ({ getStockCountPackageOptions: mocks.getOptions }));
import StockCountPackageEntry from "./StockCountPackageEntry";
const item = { catalogProductId: "juice", catalogProductName: "Orange juice", baseUnit: "l" };
const option = { id: '["case","default"]', supplierProductId: "case", purchaseOptionId: "default", supplierProductName: "Orange juice", supplierName: "Vendor", purchaseUnit: "Case", baseUnit: "l", catalogUnitsPerPackage: 6 };
const page = (options = [option], patch = {}) => ({ options, unavailable: [], nextCursor: null, ...patch });
const props = { hotelUid: "hotel-a", stockCountId: "count", locationId: "store", item };
const open = () => fireEvent.click(screen.getByRole("button", { name: "Count packages and loose contents" }));
const choose = async (index = 1) => {
  fireEvent.focus(await screen.findByRole("combobox", { name: `Validated package ${index}` }));
  fireEvent.click(screen.getByRole("option", { name: "Orange juice · Vendor · Case (6 l)" }));
};
beforeEach(() => { mocks.getOptions.mockReset(); mocks.getOptions.mockResolvedValue(page()); });
afterEach(cleanup);

describe("mobile package counting helper", () => {
  it("loads one article only on demand and applies an exact canonical quantity after an explicit action", async () => {
    const apply = vi.fn(); render(<StockCountPackageEntry {...props} onApply={apply} />);
    expect(mocks.getOptions).not.toHaveBeenCalled(); open(); await choose();
    expect(mocks.getOptions).toHaveBeenCalledWith("hotel-a", "count", "store", "juice", { baseUnit: "l" });
    fireEvent.change(screen.getByLabelText("Full packages 1"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Loose quantity (l)"), { target: { value: "0.5" } });
    expect(screen.getByText("12.5 l")).toBeInTheDocument(); expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply total to count" })); expect(apply).toHaveBeenCalledWith("12.5");
    expect(screen.queryByLabelText("Loose quantity (l)")).not.toBeInTheDocument();
  });
  it("keeps untouched fields uncounted and accepts explicit zero without guessing a package", async () => {
    mocks.getOptions.mockResolvedValue(page([])); const apply = vi.fn(); render(<StockCountPackageEntry {...props} onApply={apply} />); open();
    const loose = await screen.findByLabelText("Loose quantity (l)");
    expect(screen.getByRole("button", { name: "Apply total to count" })).toBeDisabled();
    fireEvent.change(loose, { target: { value: "0" } }); expect(screen.getByText("0 l")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply total to count" })); expect(apply).toHaveBeenCalledWith("0");
  });
  it("does not invent conversion on failure and retries the article scoped projection", async () => {
    mocks.getOptions.mockRejectedValueOnce(new Error("The package contract is unavailable")); render(<StockCountPackageEntry {...props} onApply={vi.fn()} />); open();
    expect(await screen.findByText("Direct catalog-unit counting remains available.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply total to count" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry package choices" })); await screen.findByLabelText("Loose quantity (l)");
    expect(mocks.getOptions).toHaveBeenCalledTimes(2);
  });
  it("supports multiple package types and rejects fractional full packages or excessive totals", async () => {
    render(<StockCountPackageEntry {...props} onApply={vi.fn()} />); open(); await choose();
    fireEvent.change(screen.getByLabelText("Full packages 1"), { target: { value: "0.5" } });
    expect(screen.getByRole("alert")).toHaveTextContent("whole number"); expect(screen.getByRole("button", { name: "Apply total to count" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Full packages 1"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add another package type" })); await choose(2);
    fireEvent.change(screen.getByLabelText("Full packages 2"), { target: { value: "2" } }); expect(screen.getByText("18 l")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove package entry 2" })); expect(screen.getByText("6 l")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Full packages 1"), { target: { value: "166667" } }); expect(screen.getByRole("alert")).toHaveTextContent("cannot exceed");
  });
  it("ignores a slow response from another hotel/count scope", async () => {
    let resolve; mocks.getOptions.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const { rerender } = render(<StockCountPackageEntry {...props} onApply={vi.fn()} />); open();
    await waitFor(() => expect(mocks.getOptions).toHaveBeenCalledTimes(1));
    rerender(<StockCountPackageEntry {...props} hotelUid="hotel-b" stockCountId="different" onApply={vi.fn()} />);
    await screen.findByLabelText("Loose quantity (l)"); resolve(page([{ ...option, supplierProductName: "Foreign stale product" }]));
    await waitFor(() => expect(mocks.getOptions).toHaveBeenCalledTimes(2));
    fireEvent.focus(screen.getByRole("combobox")); expect(screen.queryByRole("option", { name: /Foreign stale/ })).not.toBeInTheDocument();
  });
  it("clears stale package selections when reopening causes new contract loading", async () => {
    render(<StockCountPackageEntry {...props} onApply={vi.fn()} />); open(); await choose();
    fireEvent.change(screen.getByLabelText("Full packages 1"), { target: { value: "2" } }); expect(screen.getByText("12 l")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide package entry" })); mocks.getOptions.mockResolvedValue(page([{ ...option, catalogUnitsPerPackage: 12 }])); open();
    await screen.findByLabelText("Loose quantity (l)"); await waitFor(() => expect(screen.getByLabelText("Full packages 1")).toHaveValue(null));
    expect(screen.getByRole("button", { name: "Apply total to count" })).toBeDisabled();
  });
});
