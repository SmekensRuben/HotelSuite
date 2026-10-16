import { execFileSync } from "node:child_process";

// This helper only tests the operator's existing permissions; it never grants any.
const project = process.argv[2];
if (project !== "hotel-toolkit-staging") throw new Error("Only the fixed staging project is allowed.");
const permissions = [
  "resourcemanager.projects.get", "resourcemanager.projects.setIamPolicy",
  "serviceusage.services.enable", "iam.serviceAccounts.create",
  "iam.serviceAccounts.setIamPolicy", "iam.workloadIdentityPools.create",
  "iam.workloadIdentityPoolProviders.create", "iam.roles.create", "iam.roles.update",
  "firebase.projects.update", "firebase.clients.create", "firebaseauth.configs.update",
  "datastore.databases.create", "storage.buckets.create",
];
const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const response = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}:testIamPermissions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ permissions }),
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Read-only staging permission check failed (${response.status}); no credentials were printed.`);
const granted = new Set((await response.json()).permissions || []);
const missing = permissions.filter((permission) => !granted.has(permission));
if (missing.length) throw new Error(`Operator lacks required staging bootstrap permissions: ${missing.join(", ")}`);
console.log("Read-only staging infrastructure permission check passed. Billing/parent permissions and organization policies still apply.");
