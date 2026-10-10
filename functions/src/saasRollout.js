const { HttpsError } = require("firebase-functions/v2/https");
const { admin } = require("./config");
const { requireVerifiedUser } = require("./validation");

const SAAS_RULES_VERSION = require("./platformReleasePolicy.json").saasRulesVersion;
const ROLLOUT_GUARD = Symbol("server-validated-saas-rollout");
async function requireSaasRollout(db, tx) {
  const ref = db.doc("platformConfiguration/saasProcurement");
  const snapshot = tx ? await tx.get(ref) : await ref.get();
  if (!snapshot.exists || snapshot.data().enabled !== true || snapshot.data().rulesVersion !== SAAS_RULES_VERSION) {
    throw new HttpsError("failed-precondition", "The platform operator must finish the verified SaaS Rules rollout before making this change.");
  }
}
async function enforceRequestRollout(db, request, tx) {
  if (request[ROLLOUT_GUARD]) await requireSaasRollout(db, tx);
}
function gated(handler) {
  return async (request) => {
    requireVerifiedUser(request);
    await requireSaasRollout(admin.firestore());
    return handler({ ...request, [ROLLOUT_GUARD]: true });
  };
}
module.exports = { SAAS_RULES_VERSION, requireSaasRollout, enforceRequestRollout, gated };
