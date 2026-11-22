import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const smoke = fileURLToPath(new URL("./smoke-linux.mjs", import.meta.url));

async function fixture(t, mode) {
  const directory = await mkdtemp(path.join(tmpdir(), "nyastra-smoke-test-"));
  const record = path.join(directory, "pid");
  const executable = path.join(directory, "program");
  t.after(async () => {
    try {
      const pid = Number(await readFile(record, "utf8"));
      assert.ok(Number.isSafeInteger(pid) && pid > 1);
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const profile = process.argv[process.argv.indexOf("--user-data") + 1];
const log = path.join(profile, "vortex.log");
fs.writeFileSync(${JSON.stringify(record)}, String(process.pid));
fs.writeFileSync(log, "renderer ready\\n");
if (${JSON.stringify(mode)} === "late-fatal") {
  setTimeout(() => fs.appendFileSync(log, "renderer process crashed\\n"), 700);
}
if (${JSON.stringify(mode)} === "early-fatal") {
  fs.appendFileSync(log, "uncaught exception\\n");
}
if (${JSON.stringify(mode)} === "early-exit") setTimeout(() => process.exit(1), 700);
if (${JSON.stringify(mode)} === "stubborn-helper") {
  const helper = require("node:child_process").spawn(process.execPath, ["-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
  ], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(record + ".helper")}, String(helper.pid));
}
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  return {
    run: () => run(process.execPath, [smoke, executable], { timeout: 10_000 }),
    async assertStopped() {
      const pid = Number(await readFile(record, "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      if (mode === "stubborn-helper") {
        const helper = Number(await readFile(record + ".helper", "utf8"));
        const status = await readFile(`/proc/${helper}/status`, "utf8").catch((error) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        assert.ok(!status || /^State:\s+Z/m.test(status), "helper is still running");
      }
    },
  };
}

await test(
  "startup accepts a ready program and stops its process",
  { timeout: 15_000 },
  async (t) => {
    const program = await fixture(t, "ready");
    assert.match((await program.run()).stdout, /startup passed/);
    await program.assertStopped();
  },
);

for (const mode of ["early-fatal", "late-fatal", "early-exit"]) {
  await test(`startup rejects ${mode} and stops its process`, { timeout: 15_000 }, async (t) => {
    const program = await fixture(t, mode);
    await assert.rejects(program.run(), /Packaged (?:startup|program)/);
    await program.assertStopped();
  });
}

await test("startup stops helpers after their launcher exits", { timeout: 15_000 }, async (t) => {
  const program = await fixture(t, "stubborn-helper");
  await program.run();
  await program.assertStopped();
});
