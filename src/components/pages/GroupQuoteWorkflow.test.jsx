import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GroupQuoteCreatePage from "./GroupQuoteCreatePage";
import GroupQuoteDetailPage from "./GroupQuoteDetailPage";
import GroupQuoteEditPage from "./GroupQuoteEditPage";

const mocks = vi.hoisted(() => ({ hotel: "hotel-a", quoteId: "quote-a", add: vi.fn(), get: vi.fn(), sources: vi.fn(), navigate: vi.fn(), update: vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: mocks.hotel }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: () => false }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate, useParams: () => ({ quoteId: mocks.quoteId }) }));
vi.mock("../layout/PageShell", () => ({ default: ({ children }) => <main>{children}</main> }));
vi.mock("./GroupQuoteFormFields", () => ({ default: ({ onSubmit }) => <button onClick={() => onSubmit({ name: "Draft group", requestDate: "2027-01-01", startDate: "2027-05-01", endDate: "2027-05-02", dateRangeSemantics: "CHECKOUT_EXCLUSIVE", quoteInputSchemaVersion: "group-quote-v3-meal-basis", roomsByDate: [{ date: "2027-05-01", rooms: 20, breakfastPax: 0, bqtRevenue: 0, mealBasis: "RO" }], groupCommissionPercentage: 0 })}>Start Analysis</button> }));
vi.mock("../../services/firebaseDemandCalendar", () => ({ getDemandCalendarEvents: () => Promise.resolve([]) }));
vi.mock("../../services/firebaseQuotes", () => ({
  addQuote: mocks.add, getQuote: mocks.get, getLatestHistoryForecastSnapshot: mocks.sources,
  getHistoryQuoteDates: () => Promise.resolve([]), getGroupQuoteSettings: () => Promise.resolve({}),
  getCompsetConfiguration: () => Promise.resolve({ settings: {}, competitors: [] }),
  getLatestLighthouseSnapshot: () => Promise.resolve(null), getStayPatternModelEvidence: () => Promise.resolve({ root: null, years: [] }),
  getCompetitorGroupObservationCounts: () => Promise.resolve({}), deleteQuote: vi.fn(), updateQuote: mocks.update, hasAnalysisAffectingChanges: () => true,
  GROUP_QUOTE_ANALYSIS_MODEL_VERSION: "group-contribution-v5-optimal-portfolio", MARKET_CONTEXT_MODEL_VERSION: "market-v1", SAVED_ANALYSIS_STALE_WARNING: { code: "STALE" },
}));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

describe("quote missing-data and scoped loading workflows", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.hotel = "hotel-a"; mocks.quoteId = "quote-a"; mocks.sources.mockResolvedValue(null); mocks.add.mockResolvedValue("saved"); mocks.update.mockResolvedValue(); });
  it("saves absent PMS/nightly analysis as an explicit unavailable draft", async () => {
    render(<GroupQuoteCreatePage />);
    fireEvent.click(screen.getByRole("button", { name: "Start Analysis" }));
    const save = await screen.findByRole("button", { name: "Save Unavailable Draft" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1));
    const [hotel, saved] = mocks.add.mock.calls[0];
    expect(hotel).toBe("hotel-a");
    expect(saved).toMatchObject({ draft: true, analysisStatus: "UNAVAILABLE", integratedDisplacement: [], analysisContributionSnapshot: null });
    expect(saved.sourceAvailabilitySnapshot.pmsSnapshotDate).toBeNull();
    expect(saved.name).toBe("Draft group");
    expect(mocks.navigate).toHaveBeenCalledWith("/revenue/group-quotes/saved");
  });
  it.each([null, "", "   ", false, true])("retains an unknown required PMS value (%s) as missing instead of zero", async (unknown) => {
    mocks.sources.mockResolvedValue({ snapshotDate: "2027-01-01", coverage: {}, byDate: { "2027-05-01": { calculatedInventoryRooms: 100, individualRooms: unknown, groupRooms: 0 } } });
    render(<GroupQuoteCreatePage />);
    fireEvent.click(screen.getByRole("button", { name: "Start Analysis" }));
    const save = await screen.findByRole("button", { name: "Save Unavailable Draft" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1));
    expect(mocks.add.mock.calls[0][1].sourceAvailabilitySnapshot.pmsStatusByDate["2027-05-01"]).toBe("MISSING");
    expect(mocks.add.mock.calls[0][1].analysisStatus).toBe("UNAVAILABLE");
  });
  it("recovers failed source loading, retains quote inputs and retries failed saving", async () => {
    mocks.sources.mockRejectedValueOnce(new Error("Source offline")).mockResolvedValue(null);
    mocks.add.mockRejectedValueOnce(new Error("Save offline")).mockResolvedValue("saved");
    render(<GroupQuoteCreatePage />);
    fireEvent.click(screen.getByRole("button", { name: "Start Analysis" }));
    expect(await screen.findByText("Source offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.sources).toHaveBeenCalledTimes(2));
    const save = screen.getByRole("button", { name: "Save Unavailable Draft" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await screen.findByText("Save offline")).toBeInTheDocument();
    expect(screen.getByText("Draft group")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save Unavailable Draft" }));
    await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(2));
    expect(mocks.add.mock.calls[1][1].name).toBe("Draft group");
  });
  it("edit completes rejected load and retries saving with a stale analysis marker", async () => {
    mocks.get.mockRejectedValueOnce(new Error("Edit offline")).mockResolvedValue({ id: "quote-a", name: "Original", roomsByDate: [] });
    mocks.update.mockRejectedValueOnce(new Error("Update offline")).mockResolvedValue();
    render(<GroupQuoteEditPage />);
    expect(await screen.findByText("Edit offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start Analysis" }));
    expect(await screen.findByText("Update offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start Analysis" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls[1][2]).toMatchObject({ name: "Draft group", analysisStatus: "STALE", analysisStaleReason: "QUOTE_INPUTS_CHANGED" });
  });
  it("clears an analyzed quote immediately on a hotel change", async () => {
    const view = render(<GroupQuoteCreatePage />);
    fireEvent.click(screen.getByRole("button", { name: "Start Analysis" }));
    expect(await screen.findByText("Draft group")).toBeInTheDocument();
    mocks.hotel = "hotel-b";
    await act(async () => view.rerender(<GroupQuoteCreatePage />));
    expect(screen.queryByText("Draft group")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Unavailable Draft" })).not.toBeInTheDocument();
  });
  it("detail exposes rejected loading with retry", async () => {
    mocks.get.mockRejectedValueOnce(new Error("Quote offline")).mockResolvedValue({ id: "quote-a", name: "Recovered quote", roomsByDate: [] });
    render(<GroupQuoteDetailPage />);
    expect(await screen.findByText("Quote offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Recovered quote")).toBeInTheDocument();
  });
  it("detail ignores late previous-hotel results", async () => {
    const old = deferred(), current = deferred();
    mocks.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view = render(<GroupQuoteDetailPage />);
    mocks.hotel = "hotel-b"; mocks.quoteId = "quote-b";
    view.rerender(<GroupQuoteDetailPage />);
    await act(async () => current.resolve({ id: "quote-b", name: "Current hotel quote", roomsByDate: [] }));
    await act(async () => old.resolve({ id: "quote-a", name: "Previous hotel quote", roomsByDate: [] }));
    expect(screen.getByText("Current hotel quote")).toBeInTheDocument();
    expect(screen.queryByText("Previous hotel quote")).not.toBeInTheDocument();
  });
});
