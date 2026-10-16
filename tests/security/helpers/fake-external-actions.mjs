import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Security integration tests keep real local Auth/Firestore and inject their
// own provider objects. Permit selected workflow checks only, while the actual
// provider guards and the Resend HTTP implementation stay unusable.
export function permitInjectedTransports(t, { actions, mailQueue = false }) {
  const environmentPolicy = require("../../../functions/src/environmentPolicy");
  const { Resend } = require("../../../functions/src/config");
  for (const name of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"]) {
    assert.match(process.env[name] || "", /^(127\.0\.0\.1|localhost):\d+$/, "Fake transports require local emulators.");
  }
  assert.equal(environmentPolicy.runtimePolicy().externalActions, false);
  const requireExternalActions = environmentPolicy.requireExternalActions;
  t.mock.method(environmentPolicy, "requireExternalActions", (action) => {
    if (actions.includes(action)) return;
    return requireExternalActions(action);
  });
  if (mailQueue) t.mock.method(environmentPolicy, "externalActionsAllowed", () => true);
  t.mock.method(Resend.prototype, "fetchRequest", () => assert.fail("Only the injected email test transport is allowed."));
  for (const action of ["SFTP deliveries", "Supplier AI requests", "Search service requests"]) {
    assert.throws(() => environmentPolicy.requireExternalActions(action), { code: "failed-precondition" });
  }
}
