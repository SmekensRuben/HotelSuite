import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import QuoteOutcomeForm from "./QuoteOutcomeForm";
import CompetitorQuoteForm from "./CompetitorQuoteForm";

const mocks = vi.hoisted(() => ({ outcome: vi.fn(), observation: vi.fn(), permissions: [] }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: (feature, action) => mocks.permissions.includes(`${feature}.${action}`) }));
vi.mock("../../services/firebaseQuotes", () => ({ saveQuoteOutcome: mocks.outcome, saveCompetitorGroupObservation: mocks.observation, getAuthoritativeQuoteMealBasis: () => "RO", QUOTE_STATUSES: ["PENDING", "LOST"], LOST_REASONS: ["UNKNOWN", "PRICE"], DECLINED_REASONS: ["OTHER"] }));
const quote = { id: "quote", name: "Quote", commercialStatus: "LOST", roomsByDate: [{ date: "2027-05-01", rooms: 20 }], startDate: "2027-05-01", endDate: "2027-05-02", dateRangeSemantics: "CHECKOUT_EXCLUSIVE" };
const competitors = [{ id: "competitor", displayName: "Competitor", groupIntelligenceEnabled: true }];

describe("commercial evidence form recovery", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.permissions = []; mocks.outcome.mockResolvedValue(); mocks.observation.mockResolvedValue(); });
  it("preserves a blank unknown competitor rate and retries failed outcomes with retained inputs", async () => {
    mocks.outcome.mockRejectedValueOnce(new Error("Offline")).mockResolvedValue();
    render(<QuoteOutcomeForm hotelUid="hotel" quote={quote} competitors={competitors} />);
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Commercial context" } });
    fireEvent.change(screen.getByLabelText("Lost To"), { target: { value: "competitor" } });
    fireEvent.click(screen.getByRole("button", { name: "Update Outcome" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    expect(screen.getByLabelText("Notes")).toHaveValue("Commercial context");
    expect(mocks.outcome.mock.calls[0][2].competitorQuotedRateInclVat).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Update Outcome" }));
    expect(await screen.findByRole("status")).toHaveTextContent("saved");
    expect(mocks.outcome.mock.calls[1][2].notes).toBe("Commercial context");
    expect(mocks.outcome.mock.calls[1][3]).toEqual({ recordCompetitorObservation: false });
  });
  it("requires both intelligence actions and explicit opt-in for a coupled observation", async () => {
    mocks.permissions = ["commercialintelligence.create", "commercialintelligence.update"];
    render(<QuoteOutcomeForm hotelUid="hotel" quote={quote} competitors={competitors} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Lost To"), { target: { value: "competitor" } });
    fireEvent.change(screen.getByLabelText("Competitor Rate incl. VAT"), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Update Outcome" }));
    await waitFor(() => expect(mocks.outcome).toHaveBeenCalledTimes(1));
    expect(mocks.outcome.mock.calls[0][3]).toEqual({ recordCompetitorObservation: true });
    expect(await screen.findByRole("status")).toHaveTextContent("requested competitor observation saved");
  });
  it("reports a successful outcome accurately when refreshing the view fails", async () => {
    render(<QuoteOutcomeForm hotelUid="hotel" quote={quote} competitors={competitors} onSaved={async () => { throw new Error("Refresh offline"); }} />);
    fireEvent.click(screen.getByRole("button", { name: "Update Outcome" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Outcome saved. Refresh");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("completes rejected observation saves and allows an explicit zero-rate retry", async () => {
    mocks.observation.mockRejectedValueOnce(new Error("Offline")).mockResolvedValue();
    render(<CompetitorQuoteForm hotelUid="hotel" quote={quote} competitors={competitors} />);
    fireEvent.change(screen.getByLabelText("Quoted Rate incl. VAT"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Record Competitor Quote" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    expect(screen.getByRole("button", { name: "Record Competitor Quote" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Record Competitor Quote" }));
    await waitFor(() => expect(mocks.observation).toHaveBeenCalledTimes(2));
    expect(mocks.observation.mock.calls[1][1].competitorQuotedRateInclVat).toBe(0);
  });
});
