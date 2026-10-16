import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStockCountDraft } from "./useStockCountDraft";

const scope = { hotelUid: "hotel-a", stockCountId: "count", locationId: "bar", actorUid: "alice" };
beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("durable stock count drafts", () => {
  it("does not persist hydration and offers an explicit recovery after remount with its original location revision", () => {
    const first = renderHook(() => useStockCountDraft(scope));
    expect(window.localStorage.length).toBe(0);
    act(() => first.result.current.update({ quantities: { juice: "2" } }, 7));
    expect(first.result.current.savedLocally).toBe(true);
    first.unmount();
    const reopened = renderHook(() => useStockCountDraft(scope));
    expect(reopened.result.current.dirty).toBe(false);
    expect(reopened.result.current.recoveries).toHaveLength(1);
    let recovered;
    act(() => { recovered = reopened.result.current.recover(reopened.result.current.recoveries[0]); });
    expect(recovered).toEqual({ value: { quantities: { juice: "2" } }, baseRevision: 7 });
    expect(reopened.result.current.savedLocally).toBe(true);
    act(() => reopened.result.current.clear());
    reopened.unmount();
    const saved = renderHook(() => useStockCountDraft(scope));
    expect(saved.result.current.recoveries).toHaveLength(0);
  });

  it.each([
    { hotelUid: "hotel-b" }, { actorUid: "bob" }, { stockCountId: "other-count" }, { locationId: "kitchen" },
  ])("isolates recoveries for another scope %j", (difference) => {
    const first = renderHook(() => useStockCountDraft(scope));
    act(() => first.result.current.update({ quantities: { juice: "2" } }, 0));
    first.unmount();
    const other = renderHook(() => useStockCountDraft({ ...scope, ...difference }));
    expect(other.result.current.recoveries).toHaveLength(0);
    expect(other.result.current.dirty).toBe(false);
  });

  it("keeps two editors independent and never removes a newer draft while clearing a recovered snapshot", () => {
    const first = renderHook(() => useStockCountDraft(scope));
    const second = renderHook(() => useStockCountDraft(scope));
    act(() => first.result.current.update({ quantity: "2" }, 0));
    act(() => second.result.current.recover(second.result.current.recoveries[0]));
    act(() => first.result.current.update({ quantity: "3" }, 0));
    act(() => second.result.current.clear());
    expect(first.result.current.savedLocally).toBe(true);
    expect(first.result.current.dirty).toBe(true);
    first.unmount(); second.unmount();
    const reopened = renderHook(() => useStockCountDraft(scope));
    expect(reopened.result.current.recoveries.map((draft) => draft.value)).toEqual([{ quantity: "3" }]);
  });

  it("dismisses only the reviewed snapshot without deleting another editor's storage", () => {
    const first = renderHook(() => useStockCountDraft(scope));
    const second = renderHook(() => useStockCountDraft(scope));
    act(() => first.result.current.update({ quantity: "2" }, 0));
    const snapshot = second.result.current.recoveries[0];
    act(() => second.result.current.discard(snapshot));
    expect(window.localStorage.getItem(snapshot.key)).toBe(snapshot.raw);
    expect(second.result.current.recoveries).toHaveLength(0);
    act(() => first.result.current.update({ quantity: "4" }, 0));
    expect(second.result.current.recoveries[0].value.quantity).toBe("4");
  });

  it("retains its in-memory draft and warns on unload when storage fails, then retries", () => {
    const first = renderHook(() => useStockCountDraft(scope));
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota exhausted"); });
    act(() => first.result.current.update({ quantity: "2" }, 0));
    expect(first.result.current.dirty).toBe(true);
    expect(first.result.current.savedLocally).toBe(false);
    expect(first.result.current.storageError).toContain("Keep this page open");
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    storage.mockRestore();
    act(() => first.result.current.retryStorage());
    expect(first.result.current.savedLocally).toBe(true);
    const safeEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(safeEvent);
    expect(safeEvent.defaultPrevented).toBe(false);
  });

  it("preserves drafts when scope changes and ignores delayed updates for the old scope", () => {
    const current = renderHook((props) => useStockCountDraft(props), { initialProps: scope });
    const staleUpdate = current.result.current.update;
    act(() => staleUpdate({ quantity: "2" }, 0));
    current.rerender({ ...scope, hotelUid: "hotel-b" });
    expect(current.result.current.dirty).toBe(false);
    act(() => staleUpdate({ quantity: "99" }, 0));
    current.rerender(scope);
    expect(current.result.current.recoveries[0].value).toEqual({ quantity: "2" });
  });

  it("recovers a failed local write after SPA unmount and keeps warning until it is safely stored", () => {
    const first = renderHook(() => useStockCountDraft(scope));
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage denied"); });
    act(() => first.result.current.update({ quantity: "6" }, 2));
    first.unmount();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const reopened = renderHook(() => useStockCountDraft(scope));
    expect(reopened.result.current.recoveries).toHaveLength(1);
    expect(reopened.result.current.recoveries[0].memoryOnly).toBe(true);
    act(() => reopened.result.current.recover(reopened.result.current.recoveries[0]));
    expect(reopened.result.current.savedLocally).toBe(false);
    storage.mockRestore();
    act(() => reopened.result.current.retryStorage());
    act(() => reopened.result.current.clear());
    const safeEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(safeEvent);
    expect(safeEvent.defaultPrevented).toBe(false);
  });

  it("does not read or write drafts without an authenticated complete scope", () => {
    const current = renderHook(() => useStockCountDraft({ ...scope, actorUid: null }));
    act(() => current.result.current.update({ quantity: "2" }, 0));
    expect(window.localStorage.length).toBe(0);
    expect(current.result.current.dirty).toBe(false);
  });

  it("clears a confirmed recovered draft and its unload warning while storage writes still fail", () => {
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage denied"); });
    const removal = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("Storage denied"); });
    const first = renderHook(() => useStockCountDraft(scope));
    act(() => first.result.current.update({ quantity: "6" }, 2)); first.unmount();
    const reopened = renderHook(() => useStockCountDraft(scope));
    act(() => reopened.result.current.recover(reopened.result.current.recoveries[0]));
    act(() => reopened.result.current.clear());
    expect(reopened.result.current.dirty).toBe(false);
    expect(reopened.result.current.canLeave()).toBe(true);
    expect(reopened.result.current.recoveries).toHaveLength(0);
    expect(reopened.result.current.storageError).toContain("cleanup could not be confirmed");
    expect(reopened.result.current.storageError).not.toContain("Keep this page open");
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    reopened.unmount();
    storage.mockRestore(); removal.mockRestore();
    expect(renderHook(() => useStockCountDraft(scope)).result.current.recoveries).toHaveLength(0);
  });

  it("explicitly discards a memory-only recovery even while storage remains unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage denied"); });
    const first = renderHook(() => useStockCountDraft(scope));
    act(() => first.result.current.update({ quantity: "6" }, 2)); first.unmount();
    const reopened = renderHook(() => useStockCountDraft(scope));
    act(() => reopened.result.current.discard(reopened.result.current.recoveries[0]));
    expect(reopened.result.current.recoveries).toHaveLength(0);
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    reopened.unmount();
    expect(renderHook(() => useStockCountDraft(scope)).result.current.recoveries).toHaveLength(0);
  });

  it("keeps a newer memory draft when clearing an older recovered snapshot during storage failure", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage denied"); });
    const first = renderHook(() => useStockCountDraft(scope));
    act(() => first.result.current.update({ quantity: "6" }, 2));
    const second = renderHook(() => useStockCountDraft(scope));
    act(() => second.result.current.recover(second.result.current.recoveries[0]));
    act(() => first.result.current.update({ quantity: "7" }, 2)); first.unmount();
    act(() => second.result.current.clear());
    expect(second.result.current.recoveries.map((draft) => draft.value)).toEqual([{ quantity: "7" }]);
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    act(() => second.result.current.discard(second.result.current.recoveries[0]));
    const safeEvent = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(safeEvent);
    expect(safeEvent.defaultPrevented).toBe(false);
  });
});
