import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HeaderBar from "./HeaderBar";

let permissions;

vi.mock("../../contexts/HotelContext", () => ({
  useHotelContext: () => ({
    hotelUid: "hotel-a",
    hotelUids: [],
    permissions,
    isPlatformAdmin: false,
    selectHotel: vi.fn(),
  }),
}));
vi.mock("../../firebaseConfig", () => ({ db: {}, doc: vi.fn(), getDoc: vi.fn() }));

function renderHeader() {
  return render(<MemoryRouter><HeaderBar today="today" onLogout={vi.fn()} /></MemoryRouter>);
}

describe("HeaderBar Front Office permissions", () => {
  beforeEach(() => { permissions = []; });

  it("hides Front Office for a user without permissions", () => {
    renderHeader();
    expect(screen.queryByText("Front Office")).not.toBeInTheDocument();
    expect(screen.queryByText("Arrivals")).not.toBeInTheDocument();
    expect(screen.queryByText("Made Reservations")).not.toBeInTheDocument();
  });

  it("shows Front Office to reservations readers", () => {
    permissions = ["reservations.read"];
    renderHeader();
    expect(screen.getByText("Front Office")).toBeInTheDocument();
  });

  it("shows Front Office to hotel super administrators", () => {
    permissions = ["super.admin"];
    renderHeader();
    expect(screen.getByText("Front Office")).toBeInTheDocument();
  });
});
