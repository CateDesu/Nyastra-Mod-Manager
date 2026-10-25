import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "nyastra-security-tools-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "repo");
  const bin = path.join(directory, "bin");
  const capture = path.join(directory, "arguments.json");
  mkdirSync(root);
  mkdirSync(bin);
  for (const name of ["pnpm", "copyfiles"]) {
    const executable = path.join(bin, name);
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(process.env.CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
process.exit(Number(process.env.BUILD_STATUS || 0));
`,
    );
    chmodSync(executable, 0o700);
  }
  return {
    directory,
    root,
    capture,
    run(script, args, extra = {}) {
      return spawnSync(process.execPath, [script, ...args], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          CAPTURE: capture,
          ...extra,
        },
        encoding: "utf8",
      });
    },
  };
}

test("native copying keeps filenames and flags literal without a shell", (t) => {
  const f = fixture(t);
  const script = fileURLToPath(new URL("../extensions/copy-native.mjs", import.meta.url));
  const native = path.join(f.root, "native $(touch injected).node");
  writeFileSync(native, "fixture");
  const result = f.run(script, [native]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.capture)).args, ["-u", "1", "-f", native, "dist"]);
  assert.equal(existsSync(path.join(f.root, "injected")), false);

  const flag = "-f; touch injected";
  assert.equal(f.run(script, [flag, native]).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(f.capture)).args, [flag, native, "dist"]);
  assert.equal(existsSync(path.join(f.root, "injected")), false);
});

function buildFixture(t) {
  const f = fixture(t);
  const script = path.join(f.root, "tools/buildScripts/buildSingleExtension.js");
  mkdirSync(path.dirname(script), { recursive: true });
  copyFileSync(new URL("../tools/buildScripts/buildSingleExtension.js", import.meta.url), script);
  const extension = path.join(f.root, "extensions/games/sample");
  mkdirSync(path.join(extension, "dist"), { recursive: true });
  writeFileSync(path.join(extension, "dist/extension.js"), "fixture output");
  const destination = path.join(f.root, "out/bundledPlugins/games/sample");
  return { ...f, script, extension, destination };
}

test("extension builds copy successful output and preserve script arguments", (t) => {
  const f = buildFixture(t);
  const result = f.run(f.script, ["games/sample", "build:release"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.capture)), {
    args: ["run", "build:release"],
    cwd: f.extension,
  });
  assert.equal(readFileSync(path.join(f.destination, "extension.js"), "utf8"), "fixture output");
});

test("extension builds reject traversal, absolute paths and shell syntax before running", (t) => {
  const f = buildFixture(t);
  for (const args of [
    ["../outside"],
    [f.extension],
    ["games/../sample"],
    ["games/sample", "build; touch injected"],
  ]) {
    assert.equal(f.run(f.script, args).status, 1, String(args));
  }
  assert.equal(existsSync(f.capture), false);
  assert.equal(existsSync(f.destination), false);
  assert.equal(existsSync(path.join(f.root, "injected")), false);
});

test("extension builds refuse linked sources and output directories", (t) => {
  const f = buildFixture(t);
  const outside = path.join(f.directory, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "keep"), "unchanged");
  symlinkSync(outside, path.join(f.root, "extensions/linked"));
  assert.equal(f.run(f.script, ["linked"]).status, 1);
  assert.equal(existsSync(f.capture), false);
  mkdirSync(path.dirname(f.destination), { recursive: true });
  symlinkSync(outside, f.destination);
  const result = f.run(f.script, ["games/sample"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /linked output/);
  assert.equal(readFileSync(path.join(outside, "keep"), "utf8"), "unchanged");
  assert.equal(existsSync(path.join(outside, "extension.js")), false);
});

test("failed extension builds leave the previous bundled output intact", (t) => {
  const f = buildFixture(t);
  mkdirSync(f.destination, { recursive: true });
  writeFileSync(path.join(f.destination, "extension.js"), "previous output");
  assert.equal(f.run(f.script, ["games/sample"], { BUILD_STATUS: "1" }).status, 1);
  assert.equal(readFileSync(path.join(f.destination, "extension.js"), "utf8"), "previous output");
});
