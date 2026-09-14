import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addDoc: vi.fn(async () => ({ id: "new-event" })),
  collection: vi.fn((_db, path) => ({ path })),
  deleteDoc: vi.fn(),
  doc: vi.fn((_db, path, id) => ({ path, id })),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  onSnapshot: vi.fn(),
  serverTimestamp: vi.fn(() => "timestamp"),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
}));

vi.mock("../firebaseConfig", () => ({ db: {}, ...mocks }));

import {
  createDemandCalendarCategory,
  createDemandCalendarEvent,
  demandCalendarCategoriesPath,
  demandCalendarEventsPath,
  getDemandCalendarEvents,
  legacyDemandCalendarEventsPath,
  mergeDemandCalendarEvents,
  updateDemandCalendarCategory,
  updateDemandCalendarEvent,
} from "./firebaseDemandCalendar";

describe("Demand Calendar Firestore paths", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lets canonical events win duplicate legacy IDs", () => {
    expect(mergeDemandCalendarEvents([{ id: "same", name: "canonical" }], [{ id: "same", name: "legacy" }, { id: "old" }])).toEqual([
      { id: "same", name: "canonical" }, { id: "old" },
    ]);
  });

  it("reads canonical and legacy event collections", async () => {
    mocks.getDocs.mockResolvedValueOnce({ docs: [{ id: "same", data: () => ({ name: "canonical" }) }] })
      .mockResolvedValueOnce({ docs: [{ id: "same", data: () => ({ name: "legacy" }) }] });
    await expect(getDemandCalendarEvents("hotel")).resolves.toEqual([{ id: "same", name: "canonical" }]);
    expect(mocks.collection).toHaveBeenCalledWith({}, demandCalendarEventsPath("hotel"));
    expect(mocks.collection).toHaveBeenCalledWith({}, legacyDemandCalendarEventsPath("hotel"));
  });

  it("creates and updates events only in the canonical collection", async () => {
    await createDemandCalendarEvent("hotel", { name: "event" });
    await updateDemandCalendarEvent("hotel", "event-id", { name: "updated" });
    expect(mocks.collection).toHaveBeenCalledWith({}, "hotels/hotel/demandCalendarEvents");
    expect(mocks.doc).toHaveBeenCalledWith({}, "hotels/hotel/demandCalendarEvents", "event-id");
    expect(mocks.setDoc).toHaveBeenCalled();
  });

  it("preserves the intentional nested category collection for create and update", async () => {
    expect(demandCalendarCategoriesPath("hotel")).toBe("hotels/hotel/settings/demandCalendarCategories/categories");
    await createDemandCalendarCategory("hotel", { name: "category" });
    await updateDemandCalendarCategory("hotel", "category-id", { name: "updated" });
    expect(mocks.collection).toHaveBeenCalledWith({}, "hotels/hotel/settings/demandCalendarCategories/categories");
    expect(mocks.doc).toHaveBeenCalledWith({}, "hotels/hotel/settings/demandCalendarCategories/categories", "category-id");
  });
});
