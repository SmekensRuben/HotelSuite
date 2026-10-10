const { HttpsError } = require("firebase-functions/v2/https");
const { requireCurrentVerifiedUser } = require("./validation");
const { requireSaasRollout } = require("./saasRollout");
const PRIVATE_WORKFLOWS_VERSION = "private-workflows-v1";
async function requirePrivateWorkflows(db, tx) {
  await requireSaasRollout(db, tx);
  const ref = db.doc("platformConfiguration/privateWorkflows");
  const snapshot = tx ? await tx.get(ref) : await ref.get();
  if (!snapshot.exists || snapshot.data().enabled !== true || snapshot.data().rulesVersion !== PRIVATE_WORKFLOWS_VERSION) {
    throw new HttpsError("failed-precondition", "Private workflows are awaiting the reviewed Rules and file migration. Please contact your platform administrator.");
  }
}
async function requireCurrentStaff(request, auth) {
  return requireCurrentVerifiedUser(request, auth);
}
async function privateWorkflowsEnabled(db) {
  const [privateFlag, procurement] = await Promise.all([db.doc("platformConfiguration/privateWorkflows").get(), db.doc("platformConfiguration/saasProcurement").get()]);
  return privateFlag.data()?.enabled === true && privateFlag.data()?.rulesVersion === PRIVATE_WORKFLOWS_VERSION
    && procurement.data()?.enabled === true && procurement.data()?.rulesVersion === "saas-procurement-v1";
}
module.exports = { PRIVATE_WORKFLOWS_VERSION, requirePrivateWorkflows, requireCurrentStaff, privateWorkflowsEnabled };
