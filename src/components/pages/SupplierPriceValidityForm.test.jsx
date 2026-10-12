import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SupplierProductFormFields from "./SupplierProductFormFields";
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: "a" }) }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: async () => [{ id: "s", name: "Supplier" }] }));
vi.mock("../../services/firebaseProducts", () => ({ getCatalogProducts: async () => [{ id: "milk", name: "Milk", baseUnit: "l" }] }));
const product = { id: "offer", supplierId: "s", supplierSku: "sku", supplierProductName: "Milk case", currency: "EUR", priceBasis: "net", baseUnit: "l",
  purchaseUnit: "Case", baseUnitsPerPurchaseUnit: 6, pricePerPurchaseUnit: 12, catalogProductId: "milk" };
describe("supplier contract price validity entry", () => {
  it("keeps missing dates null and saves only manually entered contract dates", async () => {
    const save = vi.fn(); render(<SupplierProductFormFields initialData={product} onSubmit={save} submitLabel="Save" savingLabel="Saving" />);
    await screen.findByDisplayValue("Supplier");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ priceValidFrom: null, priceValidUntil: null })));
    fireEvent.change(screen.getByLabelText("Contract price valid from (optional)"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Contract price valid until (optional)"), { target: { value: "2026-10-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ priceValidFrom: "2026-10-01", priceValidUntil: "2026-10-31" })));
  });
  it("rejects reversed dates instead of sending an ambiguous contract", async () => {
    const save = vi.fn(); const { container } = render(<SupplierProductFormFields initialData={product} onSubmit={save} submitLabel="Save" savingLabel="Saving" />);
    await screen.findByDisplayValue("Supplier");
    fireEvent.change(screen.getByLabelText("Contract price valid from (optional)"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("Contract price valid until (optional)"), { target: { value: "2026-10-31" } });
    fireEvent.submit(container.querySelector("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Price valid from must not be after price valid until"); expect(save).not.toHaveBeenCalled();
  });
});
