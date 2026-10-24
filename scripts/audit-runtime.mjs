import { spawnSync } from "node:child_process";

const result = spawnSync("pnpm", ["audit", "--prod", "--json"], { encoding: "utf8" });
if (result.error || ![0, 1].includes(result.status)) {
  throw result.error ?? new Error(result.stderr || "the runtime dependency audit failed");
}
const audit = JSON.parse(result.stdout);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const counts = audit.metadata?.vulnerabilities;
const severities = ["info", "low", "moderate", "high", "critical"];
if (
  !isRecord(audit.advisories) ||
  !isRecord(counts) ||
  !severities.every((severity) => Number.isInteger(counts[severity]) && counts[severity] >= 0) ||
  !Object.values(counts).every((count) => Number.isInteger(count) && count >= 0)
) {
  throw new Error("the registry did not return a dependency audit");
}

const advisories = Object.values(audit.advisories);
for (const advisory of advisories) {
  console.log(`${advisory.severity}: ${advisory.module_name}: ${advisory.title}`);
  console.log(advisory.url);
  for (const finding of advisory.findings ?? []) {
    console.error(`Finding in ${finding.paths.join(", ")}`);
  }
}
console.log(JSON.stringify(counts));
if (
  result.status !== 0 ||
  advisories.length > 0 ||
  Object.values(counts).some((count) => count > 0)
) {
  process.exitCode = 1;
}
