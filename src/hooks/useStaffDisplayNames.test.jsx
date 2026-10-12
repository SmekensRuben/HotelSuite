import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ display: vi.fn() }));
vi.mock("../services/firebaseUserManagement", () => ({ getHotelUserDisplayName: mocks.display }));
import { useStaffDisplayNames } from "./useStaffDisplayNames";
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

beforeEach(() => { vi.clearAllMocks(); mocks.display.mockResolvedValue("Ada Lovelace"); });

describe("optional audit display labels", () => {
  it("does not display a legacy snapshot that contains the raw actor ID while names are loading", async () => {
    const pending = deferred(); mocks.display.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useStaffDisplayNames({ hotelUid: "hotel-a", scopeKey: "hotel-a:product", record: { createdBy: "actor-id", createdByName: "actor-id", updatedBy: "editor-id", updatedByName: "editor-id" } }));
    expect(result.current).toEqual({ createdByName: "Unknown hotel user", updatedByName: "Unknown hotel user" });
    await act(async () => pending.resolve("Ada Lovelace"));
    await waitFor(() => expect(result.current).toEqual({ createdByName: "Ada Lovelace", updatedByName: "Ada Lovelace" }));
  });

  it("keeps an available historic display name when optional projection fails", async () => {
    mocks.display.mockRejectedValue(new Error("Offline"));
    const { result } = renderHook(() => useStaffDisplayNames({ hotelUid: "hotel-a", scopeKey: "hotel-a:product", record: { createdBy: "actor-id", createdByName: "Historic hotel colleague" } }));
    await waitFor(() => expect(mocks.display).toHaveBeenCalledWith("hotel-a", "actor-id"));
    expect(result.current).toEqual({ createdByName: "Historic hotel colleague", updatedByName: "-" });
  });
});
