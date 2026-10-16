import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { releaseTitle } from "./release-title.mjs";

test("release titles match the program version throughout the requested sequence", () => {
  for (const [version, title] of [
    ["2.9.0", "v1.00"],
    ["2.9.1", "v1.01"],
    ["2.9.9", "v1.09"],
    ["2.9.10", "v1.10"],
    ["2.9.99", "v1.99"],
    ["2.9.100", "v1.100"],
    ["2.9.999", "v1.999"],
  ])
    assert.equal(releaseTitle(version), title);
});

test("publication refuses versions outside the numbered sequence", () => {
  for (const version of ["2.9.0-beta.2+linux.3", "2.9.1000", "2.9.01", "3.0.0", "1.00"])
    assert.throws(() => releaseTitle(version), /Release versions require/);
});

test("the publisher uses the package version and fails on invalid input", () => {
  const script = fileURLToPath(new URL("./release-title.mjs", import.meta.url));
  const run = (version) => spawnSync(process.execPath, [script, version], { encoding: "utf8" });
  const result = run("2.9.0");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "v1.00");
  assert.notEqual(run("2.9.1000").status, 0);
});
