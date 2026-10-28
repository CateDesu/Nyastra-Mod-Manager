import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { adapt, helldiversMarker, helperName } from "../linux/extension-adaptations/adapt.mjs";
import { applyExtensions } from "../linux/extension-adaptations/apply.mjs";

const installer = fileURLToPath(new URL("./install-linux.mjs", import.meta.url));

// Synthetic extension source with the supported archive scan boundary.
const helldiversSource = `
const BASE_ARCHIVE_RE = /^([0-9a-f]{16})(?:\\.gpu_resources|\\.stream)?$/i;
async function scanBaseArchives() {
  const result = new Set();
  const entries = await fsp.readdir();
  for (const entry of entries) {
    const match = BASE_ARCHIVE_RE.exec(entry);
    if (match !== null) result.add(match[1].toLowerCase());
  }
  return result;
}
`;

test("Helldivers archive checks distinguish loose and packed installations", async () => {
  const source = adapt(helldiversSource, "helldivers2");
  const sandbox = { fsp: { readdir: async () => [] } };
  vm.runInNewContext(source, sandbox);
  const archive = "0123456789abcdef";
  sandbox.fsp.readdir = async () => [archive, `${archive}.stream`, "fedcba9876543210.patch_0"];
  assert.deepEqual(Array.from(await sandbox.scanBaseArchives()), [archive]);
  for (const bundle of ["bundles.nxa", "bundles.00.nxa", "BUNDLES.NXA"]) {
    sandbox.fsp.readdir = async () => [archive, bundle];
    assert.equal((await sandbox.scanBaseArchives()).size, 0);
  }
  assert.equal(adapt(source, "helldivers2"), source);
  assert.ok(adapt(helldiversSource.replaceAll("\n", "\r\n"), "helldivers2").includes("\r\n"));
  assert.throws(() => adapt("changed upstream source", "helldivers2"), /Extension source changed/);
});

test("Helldivers adaptation preserves a backup and needs no Fluffy helper", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nyastra-helldivers-"));
  try {
    const plugin = path.join(root, "plugins", "helldivers2");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(path.join(plugin, "index.js"), helldiversSource);
    writeFileSync(
      path.join(plugin, "info.json"),
      JSON.stringify({ name: "Game: Helldivers 2", version: "1.2.2" }),
    );
    const preview = await applyExtensions({ userData: root, dryRun: true });
    assert.deepEqual(preview.adapted, ["Game: Helldivers 2"]);
    assert.equal(readFileSync(path.join(plugin, "index.js"), "utf8"), helldiversSource);
    const result = await applyExtensions({ userData: root });
    assert.deepEqual(result.adapted, preview.adapted);
    assert.equal(
      readFileSync(path.join(result.backupRoot, "helldivers2", "index.js"), "utf8"),
      helldiversSource,
    );
    assert.ok(readFileSync(path.join(plugin, "index.js"), "utf8").includes(helldiversMarker));
    assert.equal(existsSync(path.join(plugin, helperName)), false);
    assert.deepEqual((await applyExtensions({ userData: root })).adapted, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(homeName = "Home with ' apostrophe") {
  const root = mkdtempSync(path.join(tmpdir(), "vortex-install-"));
  const home = path.join(root, homeName);
  const source = path.join(root, "Extracted with ' apostrophe");
  const bin = path.join(root, "bin");
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_STATE_HOME: path.join(home, "state"),
    PATH: `${bin}:${process.env.PATH}`,
    HANDLER: path.join(root, "handler"),
    CAPTURE: path.join(root, "capture"),
  };
  for (const directory of [home, source, bin, path.join(source, "resources")])
    mkdirSync(directory, { recursive: true });
  const script = (filename, content) => {
    writeFileSync(filename, `#!${process.execPath}\n${content}\n`);
    chmodSync(filename, 0o755);
  };
  writeFileSync(path.join(source, "resources/app.asar"), "fixture archive");
  writeFileSync(path.join(source, "version"), "one");
  script(
    path.join(source, "vortex"),
    "require('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));",
  );
  script(
    path.join(bin, "xdg-mime"),
    `const fs = require('node:fs');
const [operation, value] = process.argv.slice(2);
if (operation === 'query') process.stdout.write(fs.existsSync(process.env.HANDLER) ? fs.readFileSync(process.env.HANDLER) : 'old.desktop');
else if (process.env.FAIL_ASSOCIATION === '1' && value === 'io.github.CateDesu.NyastraModManager.desktop') process.exit(1);
else fs.writeFileSync(process.env.HANDLER, value);`,
  );
  script(path.join(bin, "update-desktop-database"), "process.exit(0);");
  const app = path.join(env.XDG_DATA_HOME, "nyastra-mod-manager/app");
  const wrapper = path.join(home, ".local/bin/nyastra-mod-manager");
  const desktop = path.join(
    env.XDG_DATA_HOME,
    "applications/io.github.CateDesu.NyastraModManager.desktop",
  );
  return {
    root,
    source,
    env,
    app,
    wrapper,
    desktop,
    run: (directory = source, extra = {}) =>
      spawnSync(process.execPath, [installer, directory], {
        env: { ...env, ...extra },
        encoding: "utf8",
      }),
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("installed launcher survives extraction removal and passes literal NXM arguments", () => {
  const f = fixture();
  try {
    const installed = f.run();
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(readFileSync(f.wrapper, "utf8"), /nyastra-mod-manager\/app\/vortex/);
    assert.ok(!readFileSync(f.wrapper, "utf8").includes(f.source));
    rmSync(f.source, { recursive: true });
    const uri = "nXm://game/mods/1/files/2?key='$(touch forbidden)'&expires=3";
    const launched = spawnSync(f.wrapper, [uri], { env: f.env, encoding: "utf8" });
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(JSON.parse(readFileSync(f.env.CAPTURE, "utf8")), ["--install", uri]);
    assert.match(readFileSync(f.desktop, "utf8"), /Exec=env .* %u/);
  } finally {
    f.clean();
  }
});

test("desktop launchers preserve quotes, backslashes and shell characters", async () => {
  const f = fixture('Home with "quotes" \\slashes $dollars `ticks`');
  try {
    const installed = f.run();
    assert.equal(installed.status, 0, installed.stderr);
    const uri = "nxm://game/mods/1/files/2?key=literal";
    const launched = spawnSync("gio", ["launch", f.desktop, uri], { env: f.env, encoding: "utf8" });
    assert.equal(launched.status, 0, launched.stderr);
    for (let attempt = 0; attempt < 100 && !existsSync(f.env.CAPTURE); attempt++)
      await setTimeout(25);
    assert.deepEqual(JSON.parse(readFileSync(f.env.CAPTURE, "utf8")), ["--install", uri]);
  } finally {
    f.clean();
  }
});

test("updates replace the runtime and self installation is idempotent", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.source, "obsolete-runtime"), "old");
    assert.equal(f.run().status, 0);
    const profile = path.join(f.env.XDG_CONFIG_HOME, "NyastraModManager", "state.v2");
    const archive = path.join(f.env.XDG_DATA_HOME, "downloads", "saved-mod.zip");
    mkdirSync(path.dirname(profile), { recursive: true });
    mkdirSync(path.dirname(archive), { recursive: true });
    writeFileSync(profile, "existing profile and settings");
    writeFileSync(archive, "downloaded mod");
    rmSync(path.join(f.source, "obsolete-runtime"));
    writeFileSync(path.join(f.source, "version"), "two");
    assert.equal(f.run().status, 0);
    assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "two");
    assert.ok(!existsSync(path.join(f.app, "obsolete-runtime")));
    assert.equal(readFileSync(profile, "utf8"), "existing profile and settings");
    assert.equal(readFileSync(archive, "utf8"), "downloaded mod");
    assert.equal(f.run(f.app).status, 0);
    assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "two");
  } finally {
    f.clean();
  }
});

test("successful updates remove abandoned installer builds while failures preserve recovery files", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    const installRoot = path.dirname(f.app);
    const previous = path.join(installRoot, ".app-previous-999999");
    const partial = path.join(installRoot, ".app-install-999998");
    const unrelated = path.join(installRoot, ".app-personal-999997");
    const external = path.join(f.root, "keep-external");
    const linked = path.join(installRoot, ".app-previous-999996");
    for (const folder of [previous, partial, unrelated, external]) {
      mkdirSync(folder);
      writeFileSync(path.join(folder, "keep-or-clean"), "fixture runtime");
    }
    symlinkSync(external, linked, "dir");
    symlinkSync(external, path.join(previous, "nested-link"), "dir");
    writeFileSync(path.join(f.source, "version"), "two");
    const failed = f.run(f.source, { FAIL_ASSOCIATION: "1" });
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "one");
    assert.ok(existsSync(previous));
    assert.ok(existsSync(partial));
    const installed = f.run();
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "two");
    assert.ok(!existsSync(previous));
    assert.ok(!existsSync(partial));
    assert.ok(existsSync(unrelated));
    assert.ok(existsSync(linked));
    assert.equal(readFileSync(path.join(external, "keep-or-clean"), "utf8"), "fixture runtime");
  } finally {
    f.clean();
  }
});

test("concurrent installation cannot capture state before owning the lock", async () => {
  const f = fixture();
  const queryStarted = path.join(f.root, "query-started");
  const queryRelease = path.join(f.root, "query-release");
  let finished;
  try {
    writeFileSync(
      path.join(f.env.PATH.split(path.delimiter)[0], "xdg-mime"),
      `#!${process.execPath}
const fs = require('node:fs');
const [operation, value] = process.argv.slice(2);
if (operation === 'query') {
  const previous = fs.existsSync(process.env.HANDLER) ? fs.readFileSync(process.env.HANDLER) : 'old.desktop';
  if (process.env.QUERY_STARTED) {
    fs.writeFileSync(process.env.QUERY_STARTED, 'ready');
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(process.env.QUERY_RELEASE)) Atomics.wait(pause, 0, 0, 10);
  }
  process.stdout.write(previous);
} else if (process.env.FAIL_ASSOCIATION === '1' && value === 'io.github.CateDesu.NyastraModManager.desktop') process.exit(1);
else fs.writeFileSync(process.env.HANDLER, value);
`,
    );
    const pending = spawn(process.execPath, [installer, f.source], {
      env: { ...f.env, QUERY_STARTED: queryStarted, QUERY_RELEASE: queryRelease },
    });
    let stderr = "";
    pending.stdout.resume();
    pending.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    finished = new Promise((resolve, reject) => {
      pending.once("error", reject);
      pending.once("close", (status) => resolve({ status, stderr }));
    });
    const deadline = Date.now() + 5000;
    while (!existsSync(queryStarted) && Date.now() < deadline) await setTimeout(10);
    assert.ok(existsSync(queryStarted), "The first installer reached its state snapshot");
    const concurrent = f.run(f.source, { FAIL_ASSOCIATION: "1" });
    assert.equal(concurrent.status, 1);
    assert.match(concurrent.stderr, /Another installer is already running/);
    assert.ok(existsSync(path.join(path.dirname(f.app), ".install.lock")));
    assert.ok(!existsSync(f.env.HANDLER));
    writeFileSync(queryRelease, "continue");
    const installed = await finished;
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(
      readFileSync(f.env.HANDLER, "utf8"),
      "io.github.CateDesu.NyastraModManager.desktop",
    );
    assert.equal(f.run().status, 0, "The completed installer releases its lock");
  } finally {
    writeFileSync(queryRelease, "continue");
    await finished;
    f.clean();
  }
});

test("failed desktop registration restores the prior runtime and launcher", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    const wrapper = readFileSync(f.wrapper);
    const desktop = readFileSync(f.desktop);
    writeFileSync(path.join(f.source, "version"), "broken update");
    const result = f.run(f.source, { FAIL_ASSOCIATION: "1" });
    assert.equal(result.status, 1);
    assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "one");
    assert.deepEqual(readFileSync(f.wrapper), wrapper);
    assert.deepEqual(readFileSync(f.desktop), desktop);
    assert.equal(f.run().status, 0, "A failed installer releases its lock");
  } finally {
    f.clean();
  }
});

for (const launcher of ["wrapper", "desktop"]) {
  void test(`a read-only ${launcher} directory preserves the previous installation on failure`, () => {
    const f = fixture();
    let directory;
    try {
      assert.equal(f.run().status, 0);
      writeFileSync(f.wrapper, "previous wrapper");
      writeFileSync(f.desktop, "previous desktop");
      const wrapper = readFileSync(f.wrapper);
      const desktop = readFileSync(f.desktop);
      writeFileSync(path.join(f.source, "version"), "failed update");
      directory = path.dirname(f[launcher]);
      chmodSync(directory, 0o555);

      const failed = f.run();

      assert.equal(failed.status, 1, failed.stderr);
      assert.match(failed.stderr, /EACCES/);
      assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "one");
      assert.deepEqual(readFileSync(f.wrapper), wrapper);
      assert.deepEqual(readFileSync(f.desktop), desktop);
      chmodSync(directory, 0o755);
      assert.equal(f.run().status, 0, "The failed installer releases its lock for retry");
      assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "failed update");
    } finally {
      if (directory) chmodSync(directory, 0o755);
      f.clean();
    }
  });
}

void test("failed imported-profile cleanup does not block runtime and launcher recovery", () => {
  const f = fixture();
  const imported = path.join(f.env.XDG_CONFIG_HOME, "NyastraModManager");
  try {
    assert.equal(f.run().status, 0);
    writeFileSync(f.wrapper, "previous wrapper");
    writeFileSync(f.desktop, "previous desktop");
    writeFileSync(f.env.HANDLER, "prior-custom.desktop");
    const wrapper = readFileSync(f.wrapper);
    const desktop = readFileSync(f.desktop);
    const sourceProfile = path.join(f.root, "Vortex");
    mkdirSync(path.join(sourceProfile, "state.v2"), { recursive: true });
    writeFileSync(path.join(sourceProfile, "state.v2/CURRENT"), "MANIFEST-000001\n");
    writeFileSync(path.join(sourceProfile, "state.v2/LOCK"), "");
    writeFileSync(path.join(sourceProfile, "state.v2/MANIFEST-000001"), "source state");
    const oldFluffy = path.join(f.env.XDG_CONFIG_HOME, "vortex-native/fluffy.json");
    const copiedFluffy = path.join(f.env.XDG_CONFIG_HOME, "nyastra-mod-manager/fluffy.json");
    mkdirSync(path.dirname(oldFluffy), { recursive: true });
    writeFileSync(oldFluffy, '{"sharedFluffyRoot":"/fixture/Fluffy"}');
    writeFileSync(path.join(f.source, "version"), "failed import update");
    mkdirSync(path.join(f.source, "linux-extensions"));
    writeFileSync(
      path.join(f.source, "linux-extensions/apply.mjs"),
      `import { chmodSync } from 'node:fs';
export async function applyExtensions({ userData }) {
  chmodSync(userData, 0o500);
  throw new Error('fixture adaptation failed after import');
}`,
    );

    const failed = spawnSync(
      process.execPath,
      [installer, f.source, "--import-profile", sourceProfile],
      { env: f.env, encoding: "utf8", timeout: 20000 },
    );

    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "one");
    assert.deepEqual(readFileSync(f.wrapper), wrapper);
    assert.deepEqual(readFileSync(f.desktop), desktop);
    assert.equal(readFileSync(f.env.HANDLER, "utf8"), "prior-custom.desktop");
    assert.ok(!existsSync(copiedFluffy), "Independent Fluffy cleanup still completes");
    assert.equal(readFileSync(oldFluffy, "utf8"), '{"sharedFluffyRoot":"/fixture/Fluffy"}');
    assert.match(failed.stderr, /fixture adaptation failed after import/);
    assert.match(failed.stderr, /EACCES/);
    assert.equal(
      readFileSync(path.join(sourceProfile, "state.v2/MANIFEST-000001"), "utf8"),
      "source state",
    );
  } finally {
    if (existsSync(imported)) chmodSync(imported, 0o700);
    f.clean();
  }
});

test("failed first registration restores existing external launchers", () => {
  const f = fixture();
  try {
    mkdirSync(path.dirname(f.wrapper), { recursive: true });
    mkdirSync(path.dirname(f.desktop), { recursive: true });
    writeFileSync(f.wrapper, "old wrapper");
    writeFileSync(f.desktop, "old desktop");
    assert.equal(f.run(f.source, { FAIL_ASSOCIATION: "1" }).status, 1);
    assert.equal(readFileSync(f.wrapper, "utf8"), "old wrapper");
    assert.equal(readFileSync(f.desktop, "utf8"), "old desktop");
    assert.equal(readFileSync(f.env.HANDLER, "utf8"), "old.desktop");
    assert.ok(!existsSync(f.app));
  } finally {
    f.clean();
  }
});

test("failed extension adaptation restores the previous installed runtime", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    writeFileSync(path.join(f.source, "version"), "broken update");
    mkdirSync(path.join(f.source, "linux-extensions"));
    writeFileSync(
      path.join(f.source, "linux-extensions/apply.mjs"),
      'export async function applyExtensions() { throw new Error("fixture adaptation failed"); }',
    );
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fixture adaptation failed/);
    assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "one");
    assert.ok(!existsSync(path.join(f.app, "linux-extensions")));
    assert.ok(!result.stdout.includes("Program files:"));
  } finally {
    f.clean();
  }
});

test("an interrupted installer releases its lock without removing the lock file", async () => {
  const f = fixture();
  const queryStarted = path.join(f.root, "query-started");
  const mime = path.join(f.env.PATH.split(path.delimiter)[0], "xdg-mime");
  const original = readFileSync(mime);
  let pending;
  let finished;
  try {
    writeFileSync(
      mime,
      `#!${process.execPath}
require('node:fs').writeFileSync(process.env.QUERY_STARTED, String(process.pid));
setTimeout(() => process.exit(0), 10000);
`,
    );
    pending = spawn(process.execPath, [installer, f.source], {
      env: { ...f.env, QUERY_STARTED: queryStarted },
      stdio: "ignore",
    });
    finished = new Promise((resolve) => pending.once("close", resolve));
    const deadline = Date.now() + 5000;
    while (!existsSync(queryStarted) && Date.now() < deadline) await setTimeout(10);
    assert.ok(existsSync(queryStarted));
    pending.kill("SIGKILL");
    await finished;
    assert.ok(existsSync(path.join(path.dirname(f.app), ".install.lock")));
    writeFileSync(mime, original);
    const restarted = f.run();
    assert.equal(restarted.status, 0, restarted.stderr);
  } finally {
    pending?.kill("SIGKILL");
    await finished;
    if (existsSync(queryStarted)) {
      try {
        process.kill(Number(readFileSync(queryStarted, "utf8")), "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    f.clean();
  }
});

for (const failRegistration of [false, true]) {
  test(`failed first installation restores unset NXM associations with real xdg-mime, registration failure=${failRegistration}`, () => {
    const f = fixture();
    try {
      const realMime = spawnSync("sh", ["-c", "command -v xdg-mime"], {
        encoding: "utf8",
      }).stdout.trim();
      assert.ok(realMime, "xdg-utils is an installer prerequisite");
      const bin = f.env.PATH.split(path.delimiter)[0];
      Object.assign(f.env, {
        XDG_CURRENT_DESKTOP: "X-Generic",
        DE: "generic",
        KDE_SESSION_VERSION: "0",
        DISPLAY: "",
        DBUS_SESSION_BUS_ADDRESS: "",
        XDG_RUNTIME_DIR: path.join(f.root, "runtime"),
        XDG_CONFIG_DIRS: path.join(f.root, "system-config"),
        XDG_DATA_DIRS: path.join(f.root, "system-data"),
      });
      mkdirSync(f.env.XDG_CONFIG_HOME, { recursive: true });
      writeFileSync(path.join(bin, "kde-config"), `#!${process.execPath}\nprocess.exit(1);\n`);
      chmodSync(path.join(bin, "kde-config"), 0o755);
      writeFileSync(
        path.join(bin, "xdg-mime"),
        `#!${process.execPath}
const result = require('node:child_process').spawnSync(${JSON.stringify(realMime)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(${failRegistration} && process.argv[2] === 'default' && process.argv[3] === 'io.github.CateDesu.NyastraModManager.desktop' ? 1 : result.status);
`,
      );
      const mimeFile = path.join(f.env.XDG_CONFIG_HOME, "mimeapps.list");
      writeFileSync(
        mimeFile,
        "[Default Applications]\ntext/plain=prior.desktop;\n[Added Associations]\nx-scheme-handler/nxm=unavailable.desktop;\n",
      );
      mkdirSync(path.join(f.source, "linux-extensions"));
      writeFileSync(
        path.join(f.source, "linux-extensions/apply.mjs"),
        `export async function applyExtensions() {
const fs = await import('node:fs');
fs.appendFileSync(${JSON.stringify(mimeFile)}, '[Default Applications]\\nimage/png=concurrent.desktop;\\n');
throw new Error('fixture adaptation failed');
}`,
      );
      const failed = f.run();
      assert.equal(failed.status, 1, failed.stderr);
      const restored = readFileSync(mimeFile, "utf8");
      assert.ok(!restored.includes("io.github.CateDesu.NyastraModManager.desktop"));
      assert.match(restored, /text\/plain=prior.desktop;/);
      assert.match(restored, /x-scheme-handler\/nxm=unavailable.desktop;/);
      if (!failRegistration) assert.match(restored, /image\/png=concurrent.desktop;/);
      assert.ok(!existsSync(f.desktop));
      assert.ok(!existsSync(f.app));
      rmSync(path.join(f.source, "linux-extensions"), { recursive: true });
      const installed = f.run(f.source, { PATH: `${path.dirname(realMime)}:${f.env.PATH}` });
      assert.equal(installed.status, 0, installed.stderr);
      const query = spawnSync(realMime, ["query", "default", "x-scheme-handler/nxm"], {
        env: f.env,
        encoding: "utf8",
      });
      assert.equal(query.stdout.trim(), "io.github.CateDesu.NyastraModManager.desktop");
    } finally {
      f.clean();
    }
  });
}

test("installer explains the flock prerequisite before changing launchers", () => {
  const f = fixture();
  try {
    const failed = f.run(f.source, { PATH: f.env.PATH.split(path.delimiter)[0] });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /requires flock.*util-linux/);
    assert.ok(!existsSync(f.wrapper));
    assert.ok(!existsSync(f.env.HANDLER));
  } finally {
    f.clean();
  }
});

test("installer rejects incomplete programs, relative XDG paths and recursive sources", () => {
  const f = fixture();
  try {
    rmSync(path.join(f.source, "resources/app.asar"));
    assert.equal(f.run().status, 1);
    writeFileSync(path.join(f.source, "resources/app.asar"), "fixture archive");
    assert.equal(f.run(f.source, { XDG_DATA_HOME: "relative" }).status, 1);
    assert.equal(f.run(f.source, { XDG_DATA_HOME: path.join(f.source, "data") }).status, 1);
    assert.ok(!existsSync(f.wrapper));
  } finally {
    f.clean();
  }
});

test("installer refuses to replace a symlink or unrelated installation folder", () => {
  const f = fixture();
  try {
    mkdirSync(path.dirname(f.app), { recursive: true });
    symlinkSync(f.source, f.app, "dir");
    assert.equal(f.run().status, 1);
    rmSync(f.app);
    mkdirSync(f.app);
    writeFileSync(path.join(f.app, "precious"), "keep");
    assert.equal(f.run().status, 1);
    assert.equal(readFileSync(path.join(f.app, "precious"), "utf8"), "keep");
  } finally {
    f.clean();
  }
});
