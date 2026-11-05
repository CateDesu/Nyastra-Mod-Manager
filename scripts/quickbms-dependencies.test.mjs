import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../extensions/quickbms-support/download_dependencies.js", import.meta.url),
);

function runFixture(t, contents) {
  const directory = mkdtempSync(path.join(tmpdir(), "quickbms-dependencies-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "dist"));
  if (contents !== undefined) {
    writeFileSync(path.join(directory, "dist", "quickbms_4gb_files.exe"), contents);
  }
  const preload = path.join(directory, "fetch.cjs");
  writeFileSync(
    preload,
    `const Module = require("node:module");
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === "cross-fetch") return () => Promise.reject(new Error("fixture download attempted"));
  return load.call(this, name, ...args);
};
`,
  );
  return spawnSync(process.execPath, ["--require", preload, script], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10000,
  });
}

test("reuses the installed QuickBMS executable without a network request", (t) => {
  const result = runFixture(t, "fixture executable");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /fixture download attempted/);
});

for (const contents of [undefined, ""]) {
  test(`downloads when the QuickBMS executable is ${contents === undefined ? "missing" : "empty"}`, (t) => {
    const result = runFixture(t, contents);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fixture download attempted/);
  });
}
