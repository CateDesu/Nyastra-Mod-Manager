import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("Flatpak launcher preserves options and translates NXM links", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "nyastra-flatpak-launcher-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    path.join(directory, "zypak-wrapper"),
    `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o755 },
  );
  const launcher = fileURLToPath(new URL("../flatpak/run.sh", import.meta.url));
  for (const args of [
    [],
    ["--user-data", "/disposable/profile with spaces"],
    ["nxm://game/mods/1"],
    ["NXM://game/mods/1"],
  ]) {
    const actual = JSON.parse(
      execFileSync("/bin/sh", [launcher, ...args], {
        env: { PATH: directory },
        encoding: "utf8",
      }),
    );
    const expected = /^nxm:/i.test(args[0] || "") ? ["--download", ...args] : args;
    assert.deepEqual(actual, ["/app/main/vortex", ...expected]);
  }
});
