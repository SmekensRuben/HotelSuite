import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePlatformQuery, usePlatformScope } from "./usePlatformQuery";

afterEach(cleanup);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

it("hides previous hotel data while loading and fences responses arriving after a hotel change", async () => {
  const earlier = deferred(), newer = deferred();
  const { result, rerender } = renderHook(({ hotel }) => usePlatformQuery(() => hotel === "a" ? earlier.promise : newer.promise, hotel), { initialProps: { hotel: "a" } });
  const oldRefresh = result.current.refresh;
  rerender({ hotel: "b" });
  expect(result.current.data).toBeNull();
  await act(async () => newer.resolve({ hotelUid: "b" }));
  expect(result.current.data).toEqual({ hotelUid: "b" });
  await act(async () => earlier.resolve({ hotelUid: "a", privateMarker: "wrong hotel" }));
  expect(result.current.data).toEqual({ hotelUid: "b" });
  await act(async () => expect(await oldRefresh()).toBeNull());
  expect(result.current.data.hotelUid).toBe("b");
});

it("does not convert an unavailable query into an empty successful result", async () => {
  const error = new Error("unavailable"), loader = vi.fn().mockResolvedValueOnce({ hotelUid: "a" }).mockRejectedValueOnce(error);
  const { result } = renderHook(() => usePlatformQuery(loader, "a"));
  await waitFor(() => expect(result.current.data?.hotelUid).toBe("a"));
  await act(async () => result.current.refresh());
  expect(result.current.data).toBeNull();
  expect(result.current.error).toBe(error);
});

it("invalidates action scopes when navigating to another hotel or unmounting", () => {
  const { result, rerender, unmount } = renderHook(({ hotel }) => usePlatformScope(hotel), { initialProps: { hotel: "a" } });
  const first = result.current(); expect(first()).toBe(true);
  rerender({ hotel: "b" }); expect(first()).toBe(false);
  const second = result.current(); expect(second()).toBe(true);
  unmount(); expect(second()).toBe(false);
});
