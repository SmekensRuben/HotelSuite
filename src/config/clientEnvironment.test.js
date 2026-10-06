import { describe, expect, it } from "vitest";
import { readClientEnvironment } from "./clientEnvironment";

const completeEnvironment = {
  VITE_DEPLOYMENT_ENV: "test",
  VITE_FIREBASE_API_KEY: "test-key",
  VITE_FIREBASE_AUTH_DOMAIN: "test.firebaseapp.com",
  VITE_FIREBASE_PROJECT_ID: "hotel-test",
  VITE_FIREBASE_STORAGE_BUCKET: "hotel-test.appspot.com",
  VITE_FIREBASE_MESSAGING_SENDER_ID: "123",
  VITE_FIREBASE_APP_ID: "1:123:web:test",
};

describe("readClientEnvironment", () => {
  it("returns an explicit, complete Firebase configuration", () => {
    expect(readClientEnvironment(completeEnvironment)).toMatchObject({
      deploymentEnvironment: "test",
      firebaseConfig: { projectId: "hotel-test" },
    });
  });

  it("does not silently accept a missing Firebase variable", () => {
    expect(() => readClientEnvironment({ ...completeEnvironment, VITE_FIREBASE_PROJECT_ID: "" }))
      .toThrow("VITE_FIREBASE_PROJECT_ID");
  });

  it("does not infer a deployment environment", () => {
    expect(() => readClientEnvironment({ ...completeEnvironment, VITE_DEPLOYMENT_ENV: "" }))
      .toThrow("VITE_DEPLOYMENT_ENV");
  });
});
