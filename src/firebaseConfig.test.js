import { expect, it, vi } from "vitest";

vi.mock("./config/clientEnvironment", () => ({ readClientEnvironment: () => ({ firebaseConfig: { projectId: "demo-cache-test" }, authPolicy: { requireMfa: false } }) }));
vi.mock("firebase/app", () => ({ initializeApp: vi.fn(() => ({ name: "fixture" })) }));
vi.mock("firebase/firestore", async (original) => ({ ...await original(), initializeFirestore: vi.fn(() => ({ kind: "memory-db" })), memoryLocalCache: vi.fn(() => ({ kind: "memory-cache" })) }));
vi.mock("firebase/auth", async (original) => ({ ...await original(), getAuth: vi.fn(() => ({})) }));
vi.mock("firebase/functions", async (original) => ({ ...await original(), getFunctions: vi.fn(() => ({})) }));
vi.mock("firebase/storage", async (original) => ({ ...await original(), getStorage: vi.fn(() => ({})) }));

it("initializes hotel data with memory-only caching on shared reception computers", async () => {
  const sdk = await import("firebase/firestore");
  const config = await import("./firebaseConfig");
  expect(config.db).toEqual({ kind: "memory-db" });
  expect(sdk.initializeFirestore).toHaveBeenCalledWith({ name: "fixture" }, { localCache: { kind: "memory-cache" } });
});
