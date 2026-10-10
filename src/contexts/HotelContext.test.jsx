import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HotelProvider, useHotelContext } from "./HotelContext";

const mocks = vi.hoisted(() => ({
  selectedHotel: "first",
  authListener: null,
  currentUser: { uid: "operator", getIdTokenResult: vi.fn(async () => ({ claims: {} })) },
  getDoc: vi.fn(), getHotelBootstrap: vi.fn(), listeners: new Map(),
}));
vi.mock("../firebaseConfig", () => ({
  db: {},
  auth: { get currentUser() { return mocks.currentUser; }, onAuthStateChanged: (listener) => { mocks.authListener = listener; return () => {}; } },
  doc: (_db, path, id) => ({ path: id ? `${path}/${id}` : path }),
  getDoc: mocks.getDoc,
  onSnapshot: (reference, callback) => {
    mocks.listeners.set(reference.path, callback);
    const data = reference.path.includes("/members/")
      ? { permissions: reference.path.includes("/first/") ? ["catalogsettings.read"] : ["contracts.read"] }
      : { status: "active", modulePolicyVersion: 1, modules: ["procurement", "contracts"] };
    callback({ exists: () => true, data: () => data });
    return () => mocks.listeners.delete(reference.path);
  },
}));
vi.mock("../services/firebaseSettings", () => ({ getHotelBootstrap: mocks.getHotelBootstrap }));
vi.mock("../i18n", () => ({ default: { changeLanguage: vi.fn() } }));
vi.mock("../utils/hotelUtils", () => ({ getSelectedHotelUid: () => mocks.selectedHotel, setSelectedHotelUid: (uid) => { mocks.selectedHotel = uid; } }));

let context;
function CurrentHotel() {
  context = useHotelContext();
  return <div>{context.hotelName}|{context.authorizationSource}|{context.permissions.join(",")}</div>;
}
const snapshot = (data) => ({ exists: () => data !== null, data: () => data });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.getIdTokenResult.mockResolvedValue({ claims: {} });
  mocks.listeners.clear();
  mocks.selectedHotel = "first";
  mocks.currentUser.uid = "operator";
  mocks.getDoc.mockImplementation(async (reference) => {
    if (reference.path === "users/operator") return snapshot({ hotelUid: ["first", "second"], language: "en" });
    if (reference.path === "hotels/first/members/operator") return snapshot({ permissions: ["catalogsettings.read"] });
    if (reference.path === "hotels/second/members/operator") return snapshot({ permissions: ["contracts.read"] });
    throw new Error(`Unexpected private read: ${reference.path}`);
  });
  mocks.getHotelBootstrap.mockImplementation(async (hotelUid) => ({ hotelName: `${hotelUid} identity`, language: "en" }));
});

it("authenticates a platform operator with zero hotels without waiting for a hotel bootstrap", async () => {
  mocks.getDoc.mockResolvedValue(snapshot({ hotelUid: [] }));
  mocks.currentUser.getIdTokenResult.mockResolvedValue({ claims: { platformAdmin: true } });
  await login();
  expect(context.isPlatformAdmin).toBe(true);
  expect(context.hotelUid).toBeNull();
  expect(context.authLoading).toBe(false);
  expect(context.hotelUids).toEqual([]);
  expect(mocks.getHotelBootstrap).not.toHaveBeenCalled();
});
it("allows platform routing with no legacy Firestore profile while keeping the hotel workspace empty", async () => {
  mocks.getDoc.mockResolvedValue(snapshot(null));
  mocks.currentUser.getIdTokenResult.mockResolvedValue({ claims: { platformAdmin: true } });
  await login();
  expect(context.isPlatformAdmin).toBe(true);
  expect(context.hotelUids).toEqual([]);
  expect(context.authLoading).toBe(false);
});

it("keeps legacy operator hotel links out of the workspace unless canonical membership exists", async () => {
  mocks.currentUser.getIdTokenResult.mockResolvedValue({ claims: { platformAdmin: true } });
  mocks.getDoc.mockImplementation(async (reference) => snapshot(reference.path === "users/operator" ? { hotelUid: ["first", "second"] }
    : reference.path === "hotels/second/members/operator" ? { permissions: ["contracts.read"] } : null));
  await login();
  expect(context.hotelUids).toEqual(["second"]);
  expect(context.hotelUid).toBe("second");
});

it("removes platform UI authority when an authentication token refresh removes the claim", async () => {
  mocks.getDoc.mockResolvedValue(snapshot({ hotelUid: [] }));
  mocks.currentUser.getIdTokenResult.mockResolvedValue({ claims: { platformAdmin: true } });
  await login();
  expect(context.isPlatformAdmin).toBe(true);
  mocks.currentUser.getIdTokenResult.mockResolvedValue({ claims: {} });
  await act(async () => mocks.authListener(mocks.currentUser));
  expect(context.isPlatformAdmin).toBe(false);
  expect(context.permissions).toEqual([]);
});
afterEach(cleanup);

async function login() {
  render(<HotelProvider><CurrentHotel /></HotelProvider>);
  await act(async () => { await mocks.authListener(mocks.currentUser); });
}

it("retains valid membership authority when bootstrap identity loading fails", async () => {
  mocks.getHotelBootstrap.mockRejectedValue(new Error("unavailable"));
  await login();
  expect(screen.getByText("Hotel|membership|catalogsettings.read")).toBeInTheDocument();
  expect(context.permissionsLoading).toBe(false);
  expect(mocks.getDoc.mock.calls.map(([reference]) => reference.path)).toEqual(["users/operator"]);
});

it("refreshes permissions and hotel administration immediately from the canonical membership", async () => {
  await login();
  await act(async () => mocks.listeners.get("hotels/first/members/operator")(snapshot({ permissions: ["users.read"], hotelAdmin: true })));
  expect(context.permissions).toEqual(["users.read"]);
  expect(context.isHotelAdmin).toBe(true);
  await act(async () => mocks.listeners.get("hotels/first/members/operator")(snapshot(null)));
  expect(context.permissions).toEqual([]);
  expect(context.isHotelAdmin).toBe(false);
  expect(context.authorizationSource).toBe("missing-membership");
});

it("does not replace the current hotel with an earlier selection's deferred settings", async () => {
  await login();
  let resolveSecond;
  mocks.getHotelBootstrap.mockImplementation((hotelUid) => hotelUid === "second"
    ? new Promise((resolve) => { resolveSecond = resolve; })
    : Promise.resolve({ hotelName: "Current first" }));
  let earlierSelection;
  act(() => { earlierSelection = context.selectHotel("second"); });
  await act(async () => { await context.selectHotel("first"); });
  await waitFor(() => expect(screen.getByText("Current first|membership|catalogsettings.read")).toBeInTheDocument());
  await act(async () => {
    resolveSecond({ hotelName: "Stale second" });
    await earlierSelection;
  });
  expect(screen.getByText("Current first|membership|catalogsettings.read")).toBeInTheDocument();
  expect(context.hotelUid).toBe("first");
});
