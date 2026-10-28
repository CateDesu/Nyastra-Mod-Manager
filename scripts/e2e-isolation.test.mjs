import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const variables = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"];
const script = `
const fs = require("node:fs");
const path = require("node:path");
const { prepareVortexInstance, cleanupVortexInstance } = require(process.argv[2]);
const xdg = require(process.argv[3]);
const setup = prepareVortexInstance(process.argv[4]);
try {
  if (process.argv[5] === "startup") {
    const { PROFILE_NAME } = require(process.argv[6]);
    fs.writeFileSync(path.join(setup.env.ELECTRON_APPDATA, PROFILE_NAME, "startup.json"), "{}");
  }
  Object.assign(process.env, setup.env);
  const paths = [xdg.xdgDataHome(), xdg.xdgConfigHome(), xdg.xdgCacheHome(), xdg.xdgStateHome()];
  for (const directory of paths) {
    if (!directory.startsWith(setup.userDataDir + path.sep)) continue;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "fixture-state"), "test state");
  }
  console.log(JSON.stringify({
    paths,
    userData: setup.env.ELECTRON_USERDATA,
    appData: setup.env.ELECTRON_APPDATA,
    leakedPackaging: ["ELECTRON_RUN_AS_NODE", "APPIMAGE", "APPDIR", "IS_FLATPAK"]
      .filter(key => key in setup.env),
    desktop: setup.env.XDG_CURRENT_DESKTOP,
  }));
} finally {
  cleanupVortexInstance(setup.userDataDir);
}
`;

for (const inherited of [false, true]) {
  await test(
    `E2E state stays isolated with inherited XDG paths ${inherited}`,
    { timeout: 15_000 },
    async (t) => {
      const directory = await mkdtemp(path.join(tmpdir(), "nyastra-e2e-isolation-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const host = path.join(directory, "host");
      const env = { ...process.env };
      for (const variable of variables) {
        if (inherited) env[variable] = path.join(host, variable);
        else delete env[variable];
      }
      env.ELECTRON_RUN_AS_NODE = "1";
      env.APPIMAGE = "/fixture/parent.AppImage";
      env.APPDIR = "/fixture/parent";
      env.IS_FLATPAK = "true";
      env.XDG_CURRENT_DESKTOP = "KDE";
      const settled = await Promise.allSettled(
        ["first", "second"].map(async (name) => {
          const instance = path.join(directory, name);
          const { stdout } = await promisify(execFile)(
            process.execPath,
            [
              "--import",
              require.resolve("tsx"),
              "-e",
              script,
              "nyastra-e2e-fixture",
              path.join(root, "packages/e2e/src/vortex-instance.ts"),
              path.join(root, "src/renderer/src/util/linux/xdg.ts"),
              instance,
            ],
            { env, timeout: 10_000 },
          );
          return { instance, result: JSON.parse(stdout) };
        }),
      );
      const results = [];
      for (const entry of settled) {
        assert.equal(entry.status, "fulfilled", entry.reason?.message);
        const { instance, result } = entry.value;
        for (const location of [...result.paths, result.userData, result.appData]) {
          assert.ok(location.startsWith(instance + path.sep), `${location} escaped ${instance}`);
        }
        assert.deepEqual(result.leakedPackaging, []);
        assert.equal(result.desktop, "X-Generic");
        results.push(result);
      }
      assert.equal(new Set(results.flatMap((result) => result.paths)).size, 8);
      assert.deepEqual(await readdir(directory), []);
    },
  );
}

await test(
  "a fresh E2E instance has the program's startup settings directory",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "nyastra-e2e-startup-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await promisify(execFile)(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        "-e",
        script,
        "nyastra-e2e-fixture",
        path.join(root, "packages/e2e/src/vortex-instance.ts"),
        path.join(root, "src/renderer/src/util/linux/xdg.ts"),
        path.join(directory, "instance"),
        "startup",
        path.join(root, "src/shared/src/branding.ts"),
      ],
      { timeout: 10_000 },
    );
    assert.deepEqual(await readdir(directory), []);
  },
);
