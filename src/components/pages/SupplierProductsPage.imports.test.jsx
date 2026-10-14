import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ progress: null, permissions: [], openJob: vi.fn(), openNew: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("../../firebaseConfig", () => ({ auth: { currentUser: { uid: "manager", emailVerified: true } } }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: "hotel-a", permissions: mocks.permissions, subscriptionActive: true, subscription: { modulePolicyVersion: 1, modules: ["procurement"] } }) }));
vi.mock("../../contexts/SupplierAiImportProgressContext", () => ({ useSupplierAiImportProgress: () => mocks.progress }));
vi.mock("../../services/firebaseProducts", () => ({ getSupplierProducts: async () => ({ products: [], hasMore: false }), importSupplierProducts: vi.fn() }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSuppliers: async () => [{ id: "supplier", name: "Supplier" }] }));
vi.mock("../layout/PageShell", () => ({ default: ({ children }) => <main>{children}</main> }));
vi.mock("../shared/DataListTable", () => ({ default: () => <p>Supplier product list</p> }));
vi.mock("../catalog/SupplierProductImage", () => ({ default: () => null }));
vi.mock("../catalog/SupplierAiImportDialog", () => ({ default: () => <p>Local upload dialog</p> }));
import SupplierProductsPage from "./SupplierProductsPage";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.permissions = ["supplierproducts.read", "supplierproducts.create", "suppliers.read"];
  mocks.progress = { jobs: [{ jobId: "private-draft", source: { fileName: "Sligro.csv" }, status: "review" }, { jobId: "next-draft", source: { fileName: "Next.xlsx" }, status: "processing" }], openJob: mocks.openJob, openNew: mocks.openNew };
});
describe("supplier import entry points", () => {
  it("provides a visible session draft resume entry and keeps AI uploads globally managed", async () => {
    render(<SupplierProductsPage />);
    expect(await screen.findByRole("region", { name: "Recent supplier imports" })).toBeInTheDocument();
    expect(screen.getByText("Ready for review")).toBeInTheDocument(); expect(screen.getByText("Processing in the background")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume Sligro.csv" })); expect(mocks.openJob).toHaveBeenCalledWith("private-draft");
    fireEvent.click(screen.getByRole("button", { name: "products.actions.import" }));
    fireEvent.click(await screen.findByRole("button", { name: "AI Import" }));
    expect(mocks.openNew).toHaveBeenCalledWith(expect.objectContaining({ initialSupplierId: "" }));
    expect(screen.queryByText("Local upload dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("hides import resume and upload actions when a hotel user has read-only product access", async () => {
    mocks.permissions = ["supplierproducts.read"];
    render(<SupplierProductsPage />); await screen.findByText("Supplier product list");
    expect(screen.queryByRole("region", { name: "Recent supplier imports" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "products.actions.import" })).toBeDisabled();
    expect(mocks.openJob).not.toHaveBeenCalled();
  });
});
