import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const project = "hotel-toolkit-staging";
const backendName = `projects/${project}/locations/europe-west4/backends/${project}`;
export function parseAppHostingBootstrapArgs(args) {
  if (!args.length || (args.length === 1 && args[0] === "--dry-run")) return { apply: false };
  if (args.length !== 5 || args[0] !== "--apply" || args[1] !== "--project" || args[2] !== project
    || args[3] !== "--app-id" || !/^1:[0-9]+:web:[a-z0-9]+$/i.test(args[4])) {
    throw new Error("Use --apply --project hotel-toolkit-staging --app-id <staging Web app ID>; no other project/backend is allowed.");
  }
  return { apply: true, appId: args[4] };
}

export async function configureStagingAppHosting(args) {
  const options = parseAppHostingBootstrapArgs(args);
  if (!options.apply) {
    console.log(`Offline plan: set ${backendName} environment=staging and disable automatic traffic rollouts. No release is created.`);
    return;
  }
  const number = execFileSync("gcloud", ["projects", "describe", project, "--format=value(projectNumber)"], { encoding: "utf8" }).trim();
  if (!/^[0-9]+$/.test(number) || number === "358734544002" || !options.appId.startsWith(`1:${number}:web:`)) {
    throw new Error("Staging project number and Web app must match before configuration.");
  }
  const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  async function request(path, method = "GET", body) {
    const response = await fetch(`https://firebaseapphosting.googleapis.com/v1beta/${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Staging App Hosting ${method} failed (${response.status}); check operator permissions/API readiness. No token was printed.`);
    return response.json();
  }
  const backend = await request(backendName);
  if (![backendName, backendName.replace(`projects/${project}/`, `projects/${number}/`)].includes(backend.name)
    || backend.codebase?.repository || backend.appId !== options.appId) {
    throw new Error("Staging backend must have no Git connection and must use the selected staging Web app. Review existing settings manually.");
  }
  async function waitForOperation(update) {
    if (!update.name?.includes("/operations/")) throw new Error("App Hosting configuration did not return a verifiable operation.");
    let operation = update;
    for (let attempt = 0; !operation.done && attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      operation = await request(operation.name);
    }
    if (!operation.done || operation.error) throw new Error("Staging App Hosting configuration did not complete; inspect the Console before retrying.");
  }
  // Both updates are long-running operations. Verify each before continuing.
  await waitForOperation(await request(`${backendName}?updateMask=environment`, "PATCH", { name: backendName, environment: "staging" }));
  await waitForOperation(await request(`${backendName}/traffic?updateMask=rolloutPolicy.disabled`, "PATCH", { name: `${backendName}/traffic`, rolloutPolicy: { disabled: true } }));
  const [configured, traffic] = await Promise.all([request(backendName), request(`${backendName}/traffic`)]);
  if (configured.environment !== "staging" || traffic.rolloutPolicy?.disabled !== true) {
    throw new Error("Staging environment/automatic-rollout settings could not be verified.");
  }
  console.log("Verified staging App Hosting environment and disabled automatic rollouts; no release was created.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await configureStagingAppHosting(process.argv.slice(2));
}
