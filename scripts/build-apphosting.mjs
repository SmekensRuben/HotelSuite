import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { prepareAppHostingEnvironment } from "./apphosting-environment.mjs";

const environment = prepareAppHostingEnvironment(process.env);
const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
  env: environment, stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status === 0 && environment.VITE_DEPLOYMENT_ENV === "staging") {
  writeFileSync("dist/release.json", JSON.stringify({
    environment: "staging", projectId: environment.VITE_FIREBASE_PROJECT_ID, sha: environment.VITE_RELEASE_SHA,
  }) + "\n");
}
process.exit(result.status ?? 1);
