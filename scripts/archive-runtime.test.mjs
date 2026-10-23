import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const mainRequire = createRequire(path.join(root, "src/main/package.json"));
const sevenzip = createRequire(mainRequire.resolve("node-7z"))("7z-bin");

test("extensions and node-7z use the same patched archive tool", async () => {
  for (const extension of [
    "mod-content",
    "script-extender-error-check",
    "script-extender-installer",
    "titlebar-launcher",
  ]) {
    const extensionRequire = createRequire(
      path.join(root, "extensions", extension, "package.json"),
    );
    assert.equal(extensionRequire("7z-bin"), sevenzip);
  }
  const { stdout } = await run(sevenzip, []);
  assert.match(stdout, /7-Zip \(z\) 26\.05/);
});

test("node-7z extracts XZ, ZIP and 7z archives with the bundled executable", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nyastra-archive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const content = "Archive extraction through the runtime wrapper.\n";
  await writeFile(path.join(directory, "input.txt"), content);
  const Zip = mainRequire("node-7z");
  for (const format of ["xz", "zip", "7z"]) {
    const archive = path.join(directory, `${format === "xz" ? "input.txt" : "fixture"}.${format}`);
    const output = path.join(directory, `output-${format}`);
    await run(sevenzip, ["a", `-t${format}`, archive, "input.txt"], { cwd: directory });
    await new Zip().extractFull(archive, output);
    assert.equal(await readFile(path.join(output, "input.txt"), "utf8"), content);
  }
});
