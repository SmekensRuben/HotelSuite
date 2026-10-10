import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const policy = JSON.parse(readFileSync("config/dependency-audit-policy.json", "utf8"));
const hasExceptions = Object.values(policy.scopes).some((scope) => Object.values(scope.maximum).some((count) => count > 0));
if (hasExceptions) {
  const reviewBy = new Date(`${policy.reviewBy}T23:59:59Z`);
  if (!Number.isFinite(reviewBy.getTime()) || Date.now() > reviewBy.getTime()) {
    throw new Error(`Dependency exception baseline expired on ${policy.reviewBy}. Review and reduce it before merging.`);
  }
}

function runAudit(prefix) {
  const args = prefix
    ? ["--prefix", prefix, "audit", "--omit=dev", "--json"]
    : ["audit", "--omit=dev", "--json"];
  try {
    return JSON.parse(execFileSync("npm", args, { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "inherit"] }));
  } catch (error) {
    if (!error.stdout) throw error;
    return JSON.parse(String(error.stdout));
  }
}

let failed = false;
for (const [scope, prefix] of [["root", ""], ["functions", "functions"], ["operator", "scripts/firebase/operator-runtime"]]) {
  const lock = JSON.parse(readFileSync(`${prefix ? `${prefix}/` : ""}package-lock.json`, "utf8"));
  for (const [name, minimum] of Object.entries(policy.scopes[scope].verifiedPackages || {})) {
    const packages = Object.entries(lock.packages || {}).filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`));
    if (!packages.length) throw new Error(`${scope}: missing required verified package ${name}.`);
    const lowerBound = minimum.split(".").map(Number);
    for (const [path, entry] of packages) {
      const actual = /^\d+\.\d+\.\d+$/.test(entry.version || "") ? entry.version.split(".").map(Number) : null;
      const comparison = actual?.map((value, i) => value - lowerBound[i]).find((value) => value !== 0) || 0;
      if (!actual || comparison < 0) throw new Error(`${scope}: ${path} ${entry.version} is below verified minimum ${minimum}.`);
    }
  }
  const audit = runAudit(prefix);
  if (audit.error || !audit.metadata?.vulnerabilities || !audit.vulnerabilities) {
    throw new Error(`${scope}: npm audit did not return a valid report. Dependency verification cannot proceed.`);
  }
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

  for (const [name, vulnerability] of Object.entries(audit.vulnerabilities)) {
    if (!vulnerability.isDirect && vulnerability.severity !== "critical") continue;
    console.log(`${scope} remediation: ${JSON.stringify({
      name,
      severity: vulnerability.severity,
      range: vulnerability.range,
      fix: vulnerability.fixAvailable,
      advisories: vulnerability.via.filter((item) => typeof item === "object").map((item) => ({ title: item.title, url: item.url, range: item.range })),
    })}`);
  }

  console.log(`${scope}: ${JSON.stringify(actual)} (${hasExceptions ? `temporary baseline; review by ${policy.reviewBy}` : "zero runtime exceptions"})`);
}

if (failed) process.exitCode = 1;
