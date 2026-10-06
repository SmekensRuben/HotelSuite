import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const policy = JSON.parse(readFileSync("config/dependency-audit-policy.json", "utf8"));
const reviewBy = new Date(`${policy.reviewBy}T23:59:59Z`);

if (!Number.isFinite(reviewBy.getTime()) || Date.now() > reviewBy.getTime()) {
  throw new Error(`Dependency exception baseline expired on ${policy.reviewBy}. Review and reduce it before merging.`);
}

function runAudit(prefix) {
  const args = prefix
    ? ["--prefix", prefix, "audit", "--omit=dev", "--json"]
    : ["audit", "--omit=dev", "--json"];
  try {
    return JSON.parse(execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
  } catch (error) {
    if (!error.stdout) throw error;
    return JSON.parse(String(error.stdout));
  }
}

let failed = false;
for (const [scope, prefix] of [["root", ""], ["functions", "functions"]]) {
  const audit = runAudit(prefix);
  const actual = audit.metadata?.vulnerabilities || {};
  const maximum = policy.scopes[scope].maximum;
  for (const severity of ["critical", "high", "moderate", "low", "total"]) {
    if (Number(actual[severity] || 0) > Number(maximum[severity] || 0)) {
      console.error(`${scope}: ${severity} vulnerabilities increased (${actual[severity]} > ${maximum[severity]}).`);
      failed = true;
    }
  }

  const unexpectedDirect = Object.entries(audit.vulnerabilities || {})
    .filter(([, vulnerability]) => vulnerability.isDirect)
    .map(([name]) => name)
    .filter((name) => !policy.scopes[scope].directPackagesRequiringRemediation.includes(name));
  if (unexpectedDirect.length) {
    console.error(`${scope}: unreviewed vulnerable direct dependencies: ${unexpectedDirect.join(", ")}`);
    failed = true;
  }

  console.log(`${scope}: ${JSON.stringify(actual)} (temporary baseline; review by ${policy.reviewBy})`);
}

if (failed) process.exitCode = 1;
