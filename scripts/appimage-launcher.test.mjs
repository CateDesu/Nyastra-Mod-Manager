import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const variables = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"];

test("AppImage startup keeps empty and unset variables out of search paths", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nyastra-launcher-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const template = await readFile(new URL("./AppRun.sh", import.meta.url), "utf8");
  const launcher = path.join(directory, "AppRun");
  await writeFile(launcher, template.replace("{{.ExecutableName}}", "fixture"));
  await writeFile(
    path.join(directory, "fixture"),
    `#!${process.execPath}\nconsole.log(JSON.stringify({env:process.env,args:process.argv.slice(2)}));\n`,
    { mode: 0o755 },
  );
  for (const value of [undefined, "", "/inherited/path"]) {
    const { stdout } = await promisify(execFile)(
      "/bin/sh",
      [launcher, "space argument", "literal$()"],
      {
        cwd: tmpdir(),
        env: { APPDIR: directory, ...Object.fromEntries(variables.map((name) => [name, value])) },
      },
    );
    const result = JSON.parse(stdout);
    assert.deepEqual(result.args, ["space argument", "literal$()"]);
    for (const name of variables) {
      const entries = result.env[name].split(":");
      assert.ok(
        entries.every((entry) => path.isAbsolute(entry)),
        `${name} contains an unsafe path`,
      );
      if (value && name !== "GSETTINGS_SCHEMA_DIR") assert.ok(entries.includes(value));
    }
  }
});
