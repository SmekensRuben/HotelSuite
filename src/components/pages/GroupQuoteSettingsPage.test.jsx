import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), navigate: vi.fn() }));
vi.mock("../../services/firebaseQuotes", () => ({ getGroupQuoteSettings: mocks.get, saveGroupQuoteSettings: mocks.save, rebuildStayPatternModel: vi.fn() }));
vi.mock("../../services/firebaseLighthouse", () => ({ saveLighthouseData: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: "hotel-a" }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: () => true }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../firebaseConfig", () => ({ auth: {}, signOut: vi.fn() }));
vi.mock("../layout/HeaderBar", () => ({ default: () => null }));
vi.mock("./CompsetSettings", () => ({ default: () => null }));
import GroupQuoteSettingsPage from "./GroupQuoteSettingsPage";
const settings = { inflationPercentage: 2, displacementThresholdPercentage: 50, maxHistoricalGroupSharePercentage: 50, roomVatPercentage: 21, breakfastAllocation: 10, variableRoomCost: 20, breakfastCostPerPerson: 4, bqtContributionMarginPercentage: 50, transientDistributionCostPercentage: 10, defaultGroupCommissionPercentage: 5, defaultGroupMealBasis: "RO", expectedFutureGroupCommissionPercentage: 5, transientAverageBreakfastPax: 1, transientAverageBreakfastRevenuePerPax: 10 };
beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue(settings); mocks.save.mockResolvedValue(); });
describe("group quote settings recovery", () => {
  it("finishes a failed read and retries the scoped settings request", async () => {
    mocks.get.mockRejectedValueOnce(new Error("read denied"));
    render(<GroupQuoteSettingsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("read denied");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByLabelText("Inflation %")).toHaveValue(2));
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
  it("retains edited values after save rejection and permits a subsequent save", async () => {
    mocks.save.mockRejectedValueOnce(new Error("write denied"));
    render(<GroupQuoteSettingsPage />);
    await waitFor(() => expect(screen.getByLabelText("Inflation %")).toHaveValue(2));
    fireEvent.change(screen.getByLabelText("Inflation %"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("write denied");
    expect(screen.getByLabelText("Inflation %")).toHaveValue(3);
    expect(screen.getByRole("button", { name: "Save Settings" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/revenue/group-quotes"));
    expect(mocks.save).toHaveBeenLastCalledWith("hotel-a", expect.objectContaining({ inflationPercentage: 3 }));
  });
});
