import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: { currentUser: null }, callable: vi.fn() }));
vi.mock("../firebaseConfig", () => ({ auth: mocks.auth, functions: {}, httpsCallable: (_functions, endpoint) => (payload) => mocks.callable(endpoint, payload) }));
import { purchasingErrorCode, purchasingProcessForPath, reportPurchasingError } from "./firebasePurchasingTelemetry";

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("VITE_DEPLOYMENT_ENV", "staging"); mocks.auth.currentUser = { uid: "buyer" }; mocks.callable.mockResolvedValue({ data: { accepted: true } }); });
afterEach(() => vi.unstubAllEnvs());

it("sends only workflow/code/hotel and throttles identical reports without arbitrary error details", () => {
  const error = Object.assign(new Error("token secret@example.test https://provider.invalid/private"), { code: "functions/internal", stack: "private stack" });
  reportPurchasingError("hotel-a", "orders", error);
  reportPurchasingError("hotel-a", "orders", error);
  expect(mocks.callable).toHaveBeenCalledExactlyOnceWith("reportHotelPurchasingError", { hotelUid: "hotel-a", process: "orders", code: "internal" });
});

it("excludes expected permission, validation and concurrency failures, invalid scopes and test clients", () => {
  for (const code of ["permission-denied", "unauthenticated", "invalid-argument", "aborted", "failed-precondition", "resource-exhausted"]) reportPurchasingError("hotel-a", "orders", { code: `functions/${code}` });
  reportPurchasingError("../hotel-b", "orders", {});
  reportPurchasingError("hotel-a", "guest-personal-data", {});
  mocks.auth.currentUser = null; reportPurchasingError("hotel-a", "orders", {});
  mocks.auth.currentUser = { uid: "buyer" }; vi.stubEnv("VITE_DEPLOYMENT_ENV", "test"); reportPurchasingError("hotel-a", "orders", {});
  expect(mocks.callable).not.toHaveBeenCalled();
});

it("swallows both synchronous reporting errors and rejected requests", async () => {
  mocks.callable.mockImplementationOnce(() => { throw new Error("offline"); }).mockRejectedValueOnce(new Error("unavailable"));
  expect(() => reportPurchasingError("hotel-a", "orders", {})).not.toThrow();
  expect(() => reportPurchasingError("hotel-a", "contracts", {})).not.toThrow();
  await Promise.resolve();
  expect(mocks.callable).toHaveBeenCalledTimes(2);
});

it("classifies render routes locally without sending paths or record identifiers", () => {
  expect(purchasingProcessForPath("/orders/private-order?token=private")).toBe("orders");
  expect(purchasingProcessForPath("/catalog/supplier-products/imports/private-job")).toBe("supplier-imports");
  expect(purchasingProcessForPath("/platform/hotels/private")).toBe(null);
  expect(purchasingProcessForPath("/orders-other")).toBe(null);
  expect(purchasingErrorCode({ code: "functions/deadline-exceeded" })).toBe("deadline-exceeded");
  reportPurchasingError("hotel-a", "orders", new Error("private"), { render: true });
  expect(mocks.callable.mock.calls[0][1]).toEqual({ hotelUid: "hotel-a", process: "orders", code: "render-failed" });
});
