import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), functions: { app: { options: { projectId: "demo-hotel-suite-a00" } } }, auth: { currentUser: { getIdToken: vi.fn(async () => "fictional-session") } } }));
vi.mock("../firebaseConfig", () => ({ functions: mocks.functions, auth: mocks.auth, httpsCallable: (_functions, name) => async (data) => ({ data: await mocks.call(name, data) }) }));
const reservation = { firstName: "Ada", lastName: "Lovelace", arrivalDate: "2026-10-12", departureDate: "2026-10-13", roomType: "KING", numberOfAdults: 1, numberOfChildren: 0, comment: "" };
beforeEach(() => { vi.resetModules(); mocks.call.mockReset(); vi.unstubAllGlobals(); });
describe("rooming backend retry boundary", () => {
  it("reuses request and reservation IDs after a lost response", async () => {
    const adapter = await import("./firebaseRoomingLists"); let sends = 0;
    mocks.call.mockImplementation(async (name, input) => {
      if (name === "getRoomingList") return { revision: 0 };
      if (++sends === 1) throw Object.assign(new Error("Lost response"), { code: "functions/unavailable" });
      return { revision: 1, reservation: { id: input.reservationId, ...input.reservation } };
    });
    await adapter.getRoomingListByToken("fixture-token");
    await expect(adapter.addRoomingListReservation("fixture-token", reservation)).rejects.toThrow("Lost response");
    await adapter.addRoomingListReservation("fixture-token", reservation);
    const sendsRecorded = mocks.call.mock.calls.filter(([name]) => name === "mutateRoomingList");
    expect(sendsRecorded[1][1]).toEqual(sendsRecorded[0][1]);
  });
  it("does not submit a successful change again when the following refresh fails", async () => {
    const adapter = await import("./firebaseRoomingLists"); let revision = 0, reads = 0;
    mocks.call.mockImplementation(async (name, input) => {
      if (name === "getRoomingList") { if (++reads === 2) throw new Error("Refresh unavailable"); return { revision }; }
      revision++; return { revision, reservation: { id: input.reservationId, ...input.reservation } };
    });
    await adapter.getRoomingListByToken("fixture-token");
    const first = await adapter.addRoomingListReservation("fixture-token", reservation);
    await expect(adapter.getRoomingListByToken("fixture-token")).rejects.toThrow();
    expect(await adapter.addRoomingListReservation("fixture-token", reservation)).toEqual(first);
    expect(mocks.call.mock.calls.filter(([name]) => name === "mutateRoomingList")).toHaveLength(1);
    await adapter.getRoomingListByToken("fixture-token");
    await adapter.addRoomingListReservation("fixture-token", reservation);
    expect(mocks.call.mock.calls.filter(([name]) => name === "mutateRoomingList")).toHaveLength(2);
  });
  it("reloads explicit conflicts with a new operation ID and current revision", async () => {
    const adapter = await import("./firebaseRoomingLists"); let sends = 0, current = 1;
    mocks.call.mockImplementation(async (name) => {
      if (name === "getRoomingList") return { revision: current };
      if (++sends === 1) throw Object.assign(new Error("Stale revision"), { code: "functions/aborted" });
      return { revision: 3 };
    });
    await adapter.getRoomingListByToken("fixture-token");
    await expect(adapter.submitRoomingList("fixture-token")).rejects.toThrow();
    current = 2; await adapter.getRoomingListByToken("fixture-token"); await adapter.submitRoomingList("fixture-token");
    const sendsRecorded = mocks.call.mock.calls.filter(([name]) => name === "mutateRoomingList");
    expect(sendsRecorded[1][1].requestId).not.toBe(sendsRecorded[0][1].requestId); expect(sendsRecorded[1][1].expectedRevision).toBe(2);
  });
});
describe("private contract backend adapters", () => {
  it("resumes the same partial upload with bearer authorization and no token URL", async () => {
    const adapter = await import("./firebaseContracts"); let uploads = 0;
    mocks.call.mockResolvedValue({ contractId: "contract-a", revision: 1 });
    const fetchMock = vi.fn(async () => { if (++uploads === 1) throw new Error("Upload interrupted"); return { ok: true, json: async () => ({ fileId: "fixture" }) }; }); vi.stubGlobal("fetch", fetchMock);
    const file = { name: "maintenance.pdf", size: 10, lastModified: 1 };
    const contract = { name: "Maintenance", followers: [] };
    await expect(adapter.createContract("hotel-a", contract, [file])).rejects.toThrow("Upload interrupted");
    await adapter.createContract("hotel-a", contract, [file]);
    expect(mocks.call.mock.calls[1][1]).toEqual(mocks.call.mock.calls[0][1]);
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[0][0]);
    expect(fetchMock.mock.calls[0][0]).not.toContain("fictional-session");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer fictional-session");
    expect(fetchMock.mock.calls[0][1].headers["Content-Type"]).toBe("application/octet-stream");
  });
  it("refuses empty and oversized uploads before creating a contract", async () => {
    const adapter = await import("./firebaseContracts");
    for (const size of [0, 20 * 1024 * 1024 + 1]) await expect(adapter.createContract("hotel-a", {}, [{ name: "file", size }])).rejects.toThrow("20 MiB");
    expect(mocks.call).not.toHaveBeenCalled();
  });
});
