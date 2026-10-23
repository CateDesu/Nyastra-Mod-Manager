import { spawnSync } from "node:child_process";

// These need upstream fixes or a separate API migration.
const remaining = new Set([
  "request@2.88.2:GHSA-p8p7-x288-28g6",
  "uuid@3.4.0:GHSA-w5hq-g745-h8pq",
  "d3-color@1.4.1:GHSA-36jr-mh4h-2g58",
  "braces@3.0.3:GHSA-vfj7-8cjw-p6xm",
]);

const result = spawnSync("pnpm", ["audit", "--prod", "--json"], { encoding: "utf8" });
if (result.error || ![0, 1].includes(result.status)) {
  throw result.error ?? new Error(result.stderr || "the runtime dependency audit failed");
}
const audit = JSON.parse(result.stdout);
if (!audit.advisories || !audit.metadata?.vulnerabilities) {
  throw new Error("the registry did not return a dependency audit");
}

let failures = 0;
for (const advisory of Object.values(audit.advisories)) {
  console.log(`${advisory.severity}: ${advisory.module_name}: ${advisory.title}`);
  console.log(advisory.url);
  for (const finding of advisory.findings) {
    const key = `${advisory.module_name}@${finding.version}:${advisory.github_advisory_id}`;
    if (advisory.severity === "critical" || !remaining.has(key)) {
      failures++;
      console.error(`New finding in ${finding.paths.join(", ")}`);
    } else {
      console.log(`Known remaining finding in ${finding.paths.join(", ")}`);
    }
  }
}
console.log(JSON.stringify(audit.metadata.vulnerabilities));
if (failures > 0) {
  process.exitCode = 1;
}
