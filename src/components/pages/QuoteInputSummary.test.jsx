import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import QuoteInputSummary from "./QuoteInputSummary";

describe("QuoteInputSummary", () => {
  it("replaces the analyzed input form with key quote facts and expands editing on request", () => {
    const onEdit = vi.fn();
    render(<QuoteInputSummary quote={{ name: "Test", startDate: "2027-04-03", endDate: "2027-04-05", roomsByDate: [{ rooms: 50, bqtRevenue: 0 }, { rooms: 50, bqtRevenue: 200 }] }} mealBasis="BB" onEdit={onEdit} />);
    expect(screen.getByLabelText("Compact Quote Summary")).toHaveTextContent("Test");
    expect(screen.getByLabelText("Compact Quote Summary")).toHaveTextContent("100");
    expect(screen.getByLabelText("Compact Quote Summary")).toHaveTextContent("BB");
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit inputs" }));
    expect(onEdit).toHaveBeenCalledOnce();
  });
});
