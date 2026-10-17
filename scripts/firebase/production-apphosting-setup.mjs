// One-time operator setup; never run by the release workflow and never creates a rollout.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT, PROJECT_NUMBER, BACKEND, DEPLOY_ACCOUNT, requireProductionTarget, createProductionRequest,
  inspectProductionHosting, canonicalProductionResource, gcloud } from "./production-apphosting.mjs";

export const RELEASE_ROLE = `projects/${PROJECT}/roles/hotelsuiteProductionRelease`;
const TITLE = "HotelSuite production release";
const OPERATOR = "bestsmekens@gmail.com";
export const MONITORING_PERMISSIONS = ["resourcemanager.projects.get", "resourcemanager.projects.getIamPolicy",
  "cloudfunctions.functions.get", "cloudscheduler.jobs.get", "run.services.getIamPolicy", "logging.logMetrics.get",
  "monitoring.alertPolicies.list", "monitoring.alertPolicies.update", "monitoring.timeSeries.list",
  "datastore.entities.get", "datastore.entities.update", "firebaserules.releases.get", "firebaserules.rulesets.get", "datastore.indexes.list"];
const REPOSITORY_PERMISSIONS = ["developerconnect.gitRepositoryLinks.get", "developerconnect.gitRepositoryLinks.fetchReadToken"];

export function reviewedReleasePermissions(catalog) {
  const hosting = (catalog.includedPermissions || []).filter(permission => /^firebaseapphosting\.(backends|builds|rollouts|operations|traffics?)\.(get|list)$/.test(permission)
    || ["firebaseapphosting.builds.create", "firebaseapphosting.rollouts.create"].includes(permission));
  for (const permission of ["firebaseapphosting.backends.get", "firebaseapphosting.backends.list", "firebaseapphosting.builds.create",
    "firebaseapphosting.builds.get", "firebaseapphosting.builds.list", "firebaseapphosting.rollouts.create", "firebaseapphosting.rollouts.get", "firebaseapphosting.rollouts.list"]) {
    if (!hosting.includes(permission)) throw new Error("Google's App Hosting role catalog changed; review required release permissions before setup.");
  }
  if (!hosting.some(permission => /^firebaseapphosting\.traffics?\.get$/.test(permission)) || !hosting.includes("firebaseapphosting.operations.get")) throw new Error("App Hosting traffic/operation read permission is unavailable in the current catalog.");
  return [...hosting, ...REPOSITORY_PERMISSIONS, ...MONITORING_PERMISSIONS].sort();
}

async function waitOperation(request, operation, pause) {
  if (!operation?.name || !/\/operations\/[A-Za-z0-9_-]+$/.test(canonicalProductionResource(operation.name))) throw new Error("App Hosting setup returned an unexpected operation.");
  for (let attempt = 0; attempt < 60; attempt++) {
    if (operation.error) throw new Error("Disabling automatic App Hosting rollouts failed; inspect the cloud operation.");
    if (operation.done === true) return;
    await pause(2000);
    operation = await request("hosting", operation.name);
  }
  throw new Error("Disabling automatic App Hosting rollouts did not finish within two minutes; inspect before retrying.");
}
const hasGrant = policy => policy.bindings?.some(binding => binding.role === RELEASE_ROLE && !binding.condition
  && binding.members?.includes(`serviceAccount:${DEPLOY_ACCOUNT}`));
const samePermissions = (role, permissions) => role && role.deleted !== true && role.stage === "GA"
  && JSON.stringify([...(role.includedPermissions || [])].sort()) === JSON.stringify(permissions);

export async function configureProductionHosting({ request, apply = false, projectNumber, operator,
  pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms)) }) {
  if (projectNumber !== PROJECT_NUMBER || operator !== OPERATOR) throw new Error("Use the reviewed production project number and release operator.");
  const observed = await request("project", `projects/${PROJECT}`);
  if (observed.projectId !== PROJECT || String(observed.projectNumber) !== PROJECT_NUMBER || observed.lifecycleState !== "ACTIVE") throw new Error("Observed production project identity differs from the reviewed target.");
  const inspection = await inspectProductionHosting(request, { requireDisabled: false });
  const serviceAccount = await request("iam", `projects/${PROJECT}/serviceAccounts/${DEPLOY_ACCOUNT}`);
  if (serviceAccount.email !== DEPLOY_ACCOUNT || serviceAccount.disabled === true) throw new Error("The existing Functions deployment account must exist and be enabled; no account is created.");
  const catalog = await request("iam", "roles/firebaseapphosting.admin");
  const permissions = reviewedReleasePermissions(catalog);
  const tokenCatalog = await request("iam", "roles/developerconnect.readTokenAccessor");
  if (!tokenCatalog.includedPermissions?.includes(REPOSITORY_PERMISSIONS[1])) throw new Error("Developer Connect read-token permission is unavailable in its current role catalog.");
  const currentRole = await request("iam", RELEASE_ROLE, { allowMissing: true });
  if (currentRole && (currentRole.name !== RELEASE_ROLE || currentRole.title !== TITLE || currentRole.deleted)) throw new Error("The production release custom-role name is already occupied by an unexpected role.");
  const policy = await request("project", `projects/${PROJECT}:getIamPolicy`, { method: "POST", body: { options: { requestedPolicyVersion: 3 } } });
  const summary = { projectId: PROJECT, projectNumber: PROJECT_NUMBER, dryRun: !apply, deployAccount: DEPLOY_ACCOUNT,
    automaticRolloutsDisabled: inspection.traffic.rolloutPolicy?.disabled === true,
    role: RELEASE_ROLE, includedPermissions: permissions, customRoleReady: samePermissions(currentRole, permissions), grantReady: hasGrant(policy),
    notice: "Disabling automatic rollouts applies to development and controlled mode. No rollout, release mode, credential or runtime setting is changed." };
  if (!apply) return summary;
  if (!summary.automaticRolloutsDisabled) {
    await waitOperation(request, await request("hosting", `${BACKEND}/traffic`, { method: "PATCH", params: { updateMask: "rolloutPolicy.disabled" },
      body: { name: `${BACKEND}/traffic`, rolloutPolicy: { disabled: true } } }), pause);
  }
  if (!summary.customRoleReady) {
    const body = { title: TITLE, description: "Pinned App Hosting builds/rollouts and environment monitoring verification/pause; no backend, IAM, traffic, Rules or index administration.", stage: "GA", includedPermissions: permissions };
    await request("iam", currentRole ? RELEASE_ROLE : `projects/${PROJECT}/roles`, { method: currentRole ? "PATCH" : "POST",
      ...(currentRole ? { params: { updateMask: "title,description,stage,includedPermissions" }, body: { ...body, name: RELEASE_ROLE, etag: currentRole.etag } }
        : { body: { roleId: "hotelsuiteProductionRelease", role: body } }) });
  }
  if (!summary.grantReady) {
    const updated = structuredClone(policy); updated.bindings ||= [];
    let binding = updated.bindings.find(entry => entry.role === RELEASE_ROLE && !entry.condition);
    if (!binding) { binding = { role: RELEASE_ROLE, members: [] }; updated.bindings.push(binding); }
    binding.members.push(`serviceAccount:${DEPLOY_ACCOUNT}`);
    await request("project", `projects/${PROJECT}:setIamPolicy`, { method: "POST", body: { policy: updated } });
  }
  await inspectProductionHosting(request);
  const [role, updatedPolicy] = await Promise.all([request("iam", RELEASE_ROLE), request("project", `projects/${PROJECT}:getIamPolicy`, { method: "POST", body: { options: { requestedPolicyVersion: 3 } } })]);
  if (!samePermissions(role, permissions) || !hasGrant(updatedPolicy)) throw new Error("Production setup did not verify its custom role and exact deployment-account binding.");
  return { ...summary, automaticRolloutsDisabled: true, customRoleReady: true, grantReady: true, verified: true };
}

export function parseProductionSetupArgs(args) {
  if (args.length === 3 && ["plan", "preflight"].includes(args[0]) && args[1] === "--project" && args[2] === PROJECT) return { phase: args[0], apply: false };
  if (args.length === 5 && args[0] === "apply" && args[1] === "--project" && args[2] === PROJECT && args[3] === "--confirm-project" && args[4] === PROJECT) return { phase: "apply", apply: true };
  throw new Error("Use production-apphosting-setup.mjs plan|preflight --project hotel-toolkit, or apply --project hotel-toolkit --confirm-project hotel-toolkit.");
}
async function main() {
  const options = parseProductionSetupArgs(process.argv.slice(2)); requireProductionTarget(PROJECT);
  if (options.phase === "plan") {
    console.log(JSON.stringify({ projectId: PROJECT, projectNumber: PROJECT_NUMBER, backend: BACKEND, dryRun: true,
      deployAccount: DEPLOY_ACCOUNT, role: RELEASE_ROLE, actions: ["Disable independent App Hosting automatic rollouts in both modes", "Create/update the narrow release role from Google's current permission catalog", "Add only the exact existing deployment-account binding", "Read back and verify configuration and IAM"],
      notice: "Offline plan only. No Google Cloud state was read or changed, and no release was started." }, null, 2)); return;
  }
  const projectNumber = gcloud(["projects", "describe", PROJECT, "--format=value(projectNumber)"], "verify production identity");
  const operator = gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], "verify the active operator");
  const request = createProductionRequest(() => gcloud(["auth", "print-access-token"], "obtain short-lived operator OAuth"));
  console.log(JSON.stringify(await configureProductionHosting({ request, apply: options.apply, projectNumber, operator }), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
