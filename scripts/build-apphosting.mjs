import { spawnSync } from "node:child_process";
import { prepareAppHostingEnvironment } from "./apphosting-environment.mjs";

const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
  env: prepareAppHostingEnvironment(process.env), stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
