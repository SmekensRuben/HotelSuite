import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import SupplierOutletAccountsPage from "./SupplierOutletAccountsPage";
const mocks = vi.hoisted(() => ({ hotel: "hotel-a", permission: true, auth: { currentUser: { uid: "manager" } }, read: vi.fn(), save: vi.fn() }));
vi.mock("react-router-dom", () => ({ useParams: () => ({ supplierId: "supplier" }), useNavigate: () => vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: () => mocks.permission }));
vi.mock("../../firebaseConfig", () => ({ auth: mocks.auth, signOut: vi.fn() }));
vi.mock("../../services/firebaseSuppliers", () => ({ getSupplierOutletAccounts: mocks.read, updateSupplierOutletAccount: mocks.save }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
const account = { id: "legacy-account", supplierId: "supplier", supplierName: "Coffee supplier", outletId: "bar", outletName: "Lobby bar", accountNumber: "OLD", revision: 4 };
beforeEach(() => { vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.permission = true; mocks.auth.currentUser = { uid: "manager" }; mocks.read.mockResolvedValue([account]); mocks.save.mockResolvedValue({ id: account.id, revision: 5 }); });
async function edit() { fireEvent.click(await screen.findByRole("button", { name: "Edit account for Lobby bar" })); fireEvent.change(screen.getByLabelText("Account number"), { target: { value: "NEW" } }); }
it("edits only the account number with its stable identity/revision and reloads verified data", async () => {
  render(<SupplierOutletAccountsPage />); await edit();
  expect(screen.getByText(/Sent orders retain/)).toBeInTheDocument();
  mocks.read.mockResolvedValue([{ ...account, accountNumber: "NEW", revision: 5 }]);
  fireEvent.click(screen.getByRole("button", { name: "Save account number" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("hotel-a", account, "NEW"));
  expect(await screen.findByText("NEW")).toBeInTheDocument(); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("does not offer account editing to a reader or administrator without operational rights", async () => {
  mocks.permission = false; render(<SupplierOutletAccountsPage />); await screen.findByText("OLD");
  expect(screen.queryByRole("button", { name: /Edit account/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /New account/ })).toBeDisabled();
});
it("preserves an uncertain command for retry and does not show a false saved confirmation", async () => {
  mocks.save.mockRejectedValueOnce(Object.assign(new Error("Response unavailable"), { code: "functions/unavailable" }));
  render(<SupplierOutletAccountsPage />); await edit(); fireEvent.click(screen.getByRole("button", { name: "Save account number" }));
  await screen.findByText("Response unavailable"); expect(screen.getByLabelText("Account number")).toBeDisabled();
  expect(screen.queryByText(/Account number saved/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry same change" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2)); expect(mocks.save.mock.calls[0]).toEqual(mocks.save.mock.calls[1]);
});
it("requires a verified reload after a stale revision instead of overwriting the latest number", async () => {
  mocks.save.mockRejectedValueOnce(Object.assign(new Error("This account changed"), { code: "functions/aborted" }));
  render(<SupplierOutletAccountsPage />); await edit(); fireEvent.click(screen.getByRole("button", { name: "Save account number" }));
  await screen.findByText("This account changed"); expect(screen.getByRole("button", { name: "Save account number" })).toBeDisabled();
  mocks.read.mockResolvedValue([{ ...account, accountNumber: "OTHER", revision: 5 }]);
  fireEvent.click(screen.getByRole("button", { name: "Reload account list" })); expect(await screen.findByText("OTHER")).toBeInTheDocument();
});
it.each(["hotel", "auth"])("discards late mutation results after a %s switch, including same-UID Auth replacement", async (change) => {
  let resolve; mocks.save.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const view = render(<SupplierOutletAccountsPage />); await edit(); fireEvent.click(screen.getByRole("button", { name: "Save account number" }));
  if (change === "auth") mocks.auth.currentUser = { uid: "manager" };
  else mocks.hotel = "hotel-b";
  mocks.read.mockResolvedValue([]); view.rerender(<SupplierOutletAccountsPage />);
  await act(async () => resolve({ id: account.id, revision: 5 }));
  expect(screen.queryByText(/Account number saved/)).not.toBeInTheDocument(); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
