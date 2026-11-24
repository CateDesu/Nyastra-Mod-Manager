import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
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
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "nyastra-helldivers-")));
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
    bin,
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

function importFixture(f) {
  const source = path.join(f.root, "Vortex");
  mkdirSync(path.join(source, "state.v2"), { recursive: true });
  writeFileSync(path.join(source, "state.v2/CURRENT"), "MANIFEST-000001\n");
  writeFileSync(path.join(source, "state.v2/LOCK"), "");
  writeFileSync(path.join(source, "state.v2/MANIFEST-000001"), "source state");
  const plugin = path.join(source, "plugins/helldivers2");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(path.join(plugin, "index.js"), helldiversSource);
  writeFileSync(
    path.join(plugin, "info.json"),
    JSON.stringify({ name: "Game: Helldivers 2", version: "1.2.2" }),
  );
  const fluffy = path.join(f.env.XDG_CONFIG_HOME, "vortex-native/fluffy.json");
  mkdirSync(path.dirname(fluffy), { recursive: true });
  writeFileSync(fluffy, '{"sharedFluffyRoot":"/fixture/Fluffy"}');
  cpSync(
    fileURLToPath(new URL("../linux/extension-adaptations", import.meta.url)),
    path.join(f.source, "linux-extensions"),
    { recursive: true },
  );
  return source;
}

test("import adapts copied extensions and a later update preserves profile edits", () => {
  const f = fixture();
  try {
    const source = importFixture(f);
    const installed = spawnSync(
      process.execPath,
      [installer, f.source, "--import-profile", source],
      { env: f.env, encoding: "utf8" },
    );
    assert.equal(installed.status, 0, installed.stderr);
    const profile = path.join(f.env.XDG_CONFIG_HOME, "NyastraModManager");
    const plugin = path.join(profile, "plugins/helldivers2/index.js");
    assert.ok(readFileSync(plugin, "utf8").includes(helldiversMarker));
    assert.equal(
      readFileSync(path.join(source, "plugins/helldivers2/index.js"), "utf8"),
      helldiversSource,
    );
    const state = path.join(profile, "state.v2/MANIFEST-000001");
    writeFileSync(state, "later profile edits");
    writeFileSync(path.join(f.source, "version"), "two");
    const update = f.run();
    assert.equal(update.status, 0, update.stderr);
    assert.equal(readFileSync(state, "utf8"), "later profile edits");
    assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "two");
    assert.ok(readFileSync(plugin, "utf8").includes(helldiversMarker));
    assert.equal(
      readFileSync(path.join(source, "state.v2/MANIFEST-000001"), "utf8"),
      "source state",
    );
  } finally {
    f.clean();
  }
});

for (const existingFluffy of [false, true]) {
  test(`failed registration rolls back profile import with existing Fluffy ${existingFluffy}`, () => {
    const f = fixture();
    try {
      assert.equal(f.run().status, 0);
      const source = importFixture(f);
      const fluffy = path.join(f.env.XDG_CONFIG_HOME, "nyastra-mod-manager/fluffy.json");
      if (existingFluffy) {
        mkdirSync(path.dirname(fluffy), { recursive: true });
        writeFileSync(fluffy, "existing Fluffy settings");
      }
      writeFileSync(path.join(f.source, "version"), "two");
      const failed = spawnSync(
        process.execPath,
        [installer, f.source, "--import-profile", source],
        { env: { ...f.env, FAIL_ASSOCIATION: "1" }, encoding: "utf8" },
      );
      assert.equal(failed.status, 1, failed.stderr);
      assert.equal(existsSync(path.join(f.env.XDG_CONFIG_HOME, "NyastraModManager")), false);
      assert.equal(existsSync(fluffy), existingFluffy);
      if (existingFluffy) assert.equal(readFileSync(fluffy, "utf8"), "existing Fluffy settings");
      assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "one");
      assert.equal(
        readFileSync(path.join(source, "plugins/helldivers2/index.js"), "utf8"),
        helldiversSource,
      );
      const retry = spawnSync(process.execPath, [installer, f.source, "--import-profile", source], {
        env: f.env,
        encoding: "utf8",
      });
      assert.equal(retry.status, 0, retry.stderr);
      assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "two");
    } finally {
      f.clean();
    }
  });
}

test("failed copied extension adaptation rolls back import and registration before retry", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    const previousHandler = readFileSync(f.env.HANDLER, "utf8");
    const previousWrapper = readFileSync(f.wrapper, "utf8");
    const source = importFixture(f);
    const plugin = path.join(source, "plugins/helldivers2/index.js");
    writeFileSync(plugin, "unsupported source");
    writeFileSync(path.join(f.source, "version"), "two");
    const runImport = () =>
      spawnSync(process.execPath, [installer, f.source, "--import-profile", source], {
        env: f.env,
        encoding: "utf8",
      });
    const failed = runImport();
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /Extension source changed/);
    assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "one");
    assert.equal(readFileSync(f.wrapper, "utf8"), previousWrapper);
    assert.equal(readFileSync(f.env.HANDLER, "utf8"), previousHandler);
    assert.equal(readFileSync(plugin, "utf8"), "unsupported source");
    assert.equal(existsSync(path.join(f.env.XDG_CONFIG_HOME, "NyastraModManager")), false);
    assert.equal(
      existsSync(path.join(f.env.XDG_CONFIG_HOME, "nyastra-mod-manager/fluffy.json")),
      false,
    );
    writeFileSync(plugin, helldiversSource);
    const retried = runImport();
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "two");
    assert.ok(
      readFileSync(
        path.join(f.env.XDG_CONFIG_HOME, "NyastraModManager/plugins/helldivers2/index.js"),
        "utf8",
      ).includes(helldiversMarker),
    );
    assert.equal(readFileSync(plugin, "utf8"), helldiversSource);
  } finally {
    f.clean();
    assert.equal(existsSync(f.root), false);
  }
});

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

test("updates preserve unjournaled directories and external links", () => {
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
    assert.ok(existsSync(previous));
    assert.ok(existsSync(partial));
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
      path.join(f.bin, "xdg-mime"),
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

test("rollback preserves a runtime replaced during desktop registration", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    writeFileSync(
      path.join(f.bin, "xdg-mime"),
      `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "query") process.stdout.write("old.desktop");
else if (process.argv[3] !== "old.desktop") {
  fs.renameSync(process.env.APP, process.env.APP + ".moved");
  fs.mkdirSync(process.env.APP);
  fs.writeFileSync(process.env.APP + "/keep", "other runtime");
  process.exit(1);
}
`,
    );
    const result = f.run(f.source, { APP: f.app });
    assert.equal(result.status, 1);
    assert.equal(readFileSync(path.join(f.app, "keep"), "utf8"), "other runtime");
    const transaction = readdirSync(path.dirname(f.app)).find((name) =>
      name.startsWith(".app-install-"),
    );
    assert.equal(
      readFileSync(path.join(path.dirname(f.app), transaction, "previous/version"), "utf8"),
      "one",
    );
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

test("an interrupted installer releases its lock without removing the lock file", async (t) => {
  const f = fixture();
  const queryStarted = path.join(f.root, "query-started");
  const mime = path.join(f.bin, "xdg-mime");
  const original = readFileSync(mime);
  let pending;
  let finished;
  const failures = [];
  const attempt = async (operation) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
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
    finished = new Promise((resolve, reject) => {
      pending.once("error", reject);
      pending.once("close", resolve);
    });
    void finished.catch(() => undefined);
    const deadline = Date.now() + 5000;
    while (!existsSync(queryStarted) && Date.now() < deadline) await setTimeout(10);
    assert.ok(existsSync(queryStarted));
    pending.kill("SIGKILL");
    await finished;
    assert.ok(existsSync(path.join(path.dirname(f.app), ".install.lock")));
    writeFileSync(mime, original);
    const restarted = f.run();
    assert.equal(restarted.status, 0, restarted.stderr);
  } catch (error) {
    failures.push(error);
  } finally {
    await attempt(() => pending?.kill("SIGKILL"));
    await attempt(() => finished);
    let pid;
    await attempt(() => {
      if (existsSync(queryStarted)) {
        const value = Number(readFileSync(queryStarted, "utf8"));
        assert.ok(Number.isSafeInteger(value) && value > 0, "The query PID must be valid");
        pid = value;
      }
    });
    if (pid !== undefined) {
      await attempt(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      });
      await attempt(async () => {
        const deadline = Date.now() + 15000;
        while (true) {
          try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) break;
          } catch (error) {
            if (error.code === "ENOENT") break;
            throw error;
          }
          assert.ok(
            Date.now() < deadline,
            "The installer query process must settle before cleanup",
          );
          await setTimeout(10);
        }
      });
    }
    await attempt(() => f.clean());
  }
  for (const error of failures.slice(1)) t.diagnostic(String(error));
  if (failures.length > 0) throw failures[0];
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

for (const prefix of ["install", "previous"]) {
  test(`installer preserves an existing ${prefix} transaction directory`, () => {
    const f = fixture();
    try {
      assert.equal(f.run().status, 0);
      const mime = path.join(f.bin, "xdg-mime");
      const original = readFileSync(mime, "utf8");
      writeFileSync(
        mime,
        `${original}\nif (operation === 'query') {
const directory = require('node:path').join(process.env.XDG_DATA_HOME, 'nyastra-mod-manager', '.app-${prefix}-' + process.ppid);
fs.mkdirSync(directory);
fs.writeFileSync(require('node:path').join(directory, 'keep'), 'existing transaction');
fs.writeFileSync(process.env.CAPTURE, directory);
}\n`,
      );
      writeFileSync(path.join(f.source, "version"), "new version");
      const installed = f.run();
      assert.equal(installed.status, 0, installed.stderr);
      assert.equal(
        readFileSync(path.join(readFileSync(f.env.CAPTURE, "utf8"), "keep"), "utf8"),
        "existing transaction",
      );
      assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "new version");
    } finally {
      f.clean();
    }
  });
}

for (const failure of ["preparation", "write"]) {
  test(`extension batch ${failure} failure preserves earlier plugins and permits retry`, async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "nyastra-extension-batch-")));
    const recipe = path.join(root, "recipe");
    const userData = path.join(root, "profile");
    const second = path.join(userData, "plugins/second");
    try {
      cpSync(fileURLToPath(new URL("../linux/extension-adaptations", import.meta.url)), recipe, {
        recursive: true,
      });
      const plugins = ["first", "second"].map((directory) => ({
        directory,
        name: `Fixture ${directory}`,
        version: "1.0.0",
        game: "helldivers2",
        helper: false,
      }));
      writeFileSync(path.join(recipe, "manifest.json"), JSON.stringify({ plugins }));
      for (const plugin of plugins) {
        const directory = path.join(userData, "plugins", plugin.directory);
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, "index.js"), helldiversSource);
        writeFileSync(path.join(directory, "info.json"), JSON.stringify(plugin));
      }
      const { applyExtensions: applyBatch } = await import(
        new URL(`file://${recipe}/apply.mjs`).href
      );
      if (failure === "preparation")
        writeFileSync(path.join(second, "index.js"), "unsupported source");
      else chmodSync(second, 0o500);
      await assert.rejects(
        applyBatch({ userData }),
        failure === "preparation" ? /Extension source changed/ : /EACCES/,
      );
      assert.equal(
        readFileSync(path.join(userData, "plugins/first/index.js"), "utf8"),
        helldiversSource,
      );
      assert.equal(
        readFileSync(path.join(second, "index.js"), "utf8"),
        failure === "preparation" ? "unsupported source" : helldiversSource,
      );
      chmodSync(second, 0o700);
      writeFileSync(path.join(second, "index.js"), helldiversSource);
      const result = await applyBatch({ userData });
      assert.deepEqual(result.adapted, ["Fixture first", "Fixture second"]);
      for (const plugin of plugins) {
        assert.equal(
          readFileSync(path.join(result.backupRoot, plugin.directory, "index.js"), "utf8"),
          helldiversSource,
        );
        assert.ok(
          readFileSync(
            path.join(userData, "plugins", plugin.directory, "index.js"),
            "utf8",
          ).includes(helldiversMarker),
        );
      }
      assert.deepEqual((await applyBatch({ userData })).adapted, []);
    } finally {
      if (existsSync(second)) chmodSync(second, 0o700);
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false);
    }
  });
}

for (const boundary of ["old-rename", "new-publish"]) {
  test(`a failed retry recovers a runtime interrupted at ${boundary}`, async () => {
    const f = fixture();
    let child;
    let finished;
    try {
      assert.equal(f.run().status, 0);
      const wrapper = readFileSync(f.wrapper);
      const desktop = readFileSync(f.desktop);
      writeFileSync(path.join(f.source, "version"), "two");
      const ready = path.join(f.root, "boundary.json");
      const hook = path.join(f.root, "boundary.cjs");
      writeFileSync(
        hook,
        `
const fs = require('node:fs');
const rename = fs.renameSync;
fs.renameSync = (source, destination) => {
  const result = rename(source, destination);
  const old = source === process.env.APP && /(?:\\/previous|\\.app-previous-\\d+)$/.test(destination);
  const published = destination === process.env.APP && /\\.app-install-[^/]+\\/app$/.test(source);
  if ((process.env.BOUNDARY === 'old-rename' && old) || (process.env.BOUNDARY === 'new-publish' && published)) {
    fs.writeFileSync(process.env.READY, JSON.stringify({source, destination}));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return result;
};
require('node:module').syncBuiltinESMExports();
`,
      );
      child = spawn(process.execPath, ["--require", hook, installer, f.source], {
        env: { ...f.env, APP: f.app, BOUNDARY: boundary, READY: ready },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      finished = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      const deadline = Date.now() + 10000;
      while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline)
        await setTimeout(10);
      assert.ok(existsSync(ready), `real rename boundary reached: ${stderr}`);
      const cut = JSON.parse(readFileSync(ready, "utf8"));
      child.kill("SIGKILL");
      assert.deepEqual(await finished, { code: null, signal: "SIGKILL" });
      assert.equal(stderr, "");
      if (boundary === "old-rename") {
        assert.equal(readFileSync(path.join(cut.destination, "version"), "utf8"), "one");
        assert.equal(spawnSync(f.wrapper, [], { env: f.env }).status, 127);
      } else {
        assert.equal(spawnSync(f.wrapper, [], { env: f.env }).status, 0);
      }
      const failed = f.run(f.source, { FAIL_ASSOCIATION: "1" });
      assert.equal(failed.status, 1, failed.stderr);
      assert.match(failed.stderr, /xdg-mime/);
      assert.equal(
        readFileSync(path.join(f.app, "version"), "utf8"),
        boundary === "old-rename" ? "one" : "two",
      );
      assert.equal(
        spawnSync(f.wrapper, [], { env: f.env }).status,
        0,
        "the actual launcher works after the failed retry",
      );
      assert.deepEqual(readFileSync(f.wrapper), wrapper);
      assert.deepEqual(readFileSync(f.desktop), desktop);
      assert.ok(
        readdirSync(path.dirname(f.app)).some((name) => name.startsWith(".app-install-")),
        "abandoned transaction retained until success",
      );
      const success = f.run();
      assert.equal(success.status, 0, success.stderr);
      assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "two");
      assert.equal(spawnSync(f.wrapper, [], { env: f.env }).status, 0);
      assert.deepEqual(
        readdirSync(path.dirname(f.app)).filter((name) => name.startsWith(".app-")),
        [],
      );
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      await finished;
      f.clean();
    }
  });
}

test("failed registration preserves Fluffy replaced after production import publication", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    const profile = importFixture(f);
    const target = path.join(f.env.XDG_CONFIG_HOME, "nyastra-mod-manager/fluffy.json");
    const original = path.join(f.env.XDG_CONFIG_HOME, "vortex-native/fluffy.json");
    const independent = '{"sharedFluffyRoot":"/fixture/independent"}';
    const mime = path.join(f.bin, "xdg-mime");
    writeFileSync(
      mime,
      `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'query') process.stdout.write('old.desktop');
else if (process.argv[3] === 'io.github.CateDesu.NyastraModManager.desktop') {
  if (fs.readFileSync(process.env.TARGET, 'utf8') !== fs.readFileSync(process.env.ORIGINAL, 'utf8')) throw new Error('import was not published');
  fs.writeFileSync(process.env.TARGET + '.replacement', process.env.INDEPENDENT);
  fs.renameSync(process.env.TARGET + '.replacement', process.env.TARGET);
  process.exit(1);
}
`,
    );
    const result = spawnSync(process.execPath, [installer, f.source, "--import-profile", profile], {
      env: { ...f.env, TARGET: target, ORIGINAL: original, INDEPENDENT: independent },
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /xdg-mime/);
    assert.equal(readFileSync(target, "utf8"), independent);
    assert.equal(readFileSync(original, "utf8"), '{"sharedFluffyRoot":"/fixture/Fluffy"}');
    assert.equal(existsSync(path.join(f.env.XDG_CONFIG_HOME, "NyastraModManager")), false);
    assert.equal(spawnSync(f.wrapper, [], { env: f.env }).status, 0);
    assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "one");
    const claims = readdirSync(path.dirname(target)).filter((name) =>
      name.startsWith(".fluffy-rollback-"),
    );
    assert.equal(claims.length, 1);
    assert.equal(
      readFileSync(path.join(path.dirname(target), claims[0], "fluffy.json"), "utf8"),
      independent,
    );
  } finally {
    f.clean();
  }
});

test("recovery preserves a replaced backup and refuses its journal", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    const staging = path.join(path.dirname(f.app), ".app-install-999999-AbCdEf");
    const previous = path.join(staging, "previous");
    mkdirSync(previous, { recursive: true });
    const identify = (filename) => {
      const info = lstatSync(filename, { bigint: true });
      return { dev: String(info.dev), ino: String(info.ino) };
    };
    const record = { version: 1, staging: identify(staging), previous: identify(previous) };
    writeFileSync(path.join(staging, "transaction.json"), JSON.stringify(record));
    renameSync(previous, path.join(f.root, "saved-previous"));
    mkdirSync(previous);
    writeFileSync(path.join(previous, "independent"), "keep this directory");
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /recovery needs manual review/);
    assert.equal(readFileSync(path.join(previous, "independent"), "utf8"), "keep this directory");
    assert.ok(existsSync(path.join(f.root, "saved-previous")));
    assert.equal(spawnSync(f.wrapper, [], { env: f.env }).status, 0);
    assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "one");
  } finally {
    f.clean();
  }
});

for (const journaled of [true, false])
  test(`rollback interrupted after claim recovers the independent configuration, journaled=${journaled}`, () => {
    const f = fixture();
    const source = path.join(f.root, "Vortex");
    try {
      assert.equal(f.run().status, 0);
      mkdirSync(path.join(source, "state.v2"), { recursive: true });
      writeFileSync(path.join(source, "state.v2/CURRENT"), "MANIFEST-000001");
      writeFileSync(path.join(source, "state.v2/LOCK"), "");
      const original = path.join(f.env.XDG_CONFIG_HOME, "vortex-native/fluffy.json");
      const target = path.join(f.env.XDG_CONFIG_HOME, "nyastra-mod-manager/fluffy.json");
      mkdirSync(path.dirname(original), { recursive: true });
      writeFileSync(original, '{"root":"original"}');
      const independent = '{"root":"independent"}';
      const hook = path.join(f.root, "claim-cut.cjs");
      writeFileSync(
        hook,
        `const fs=require('node:fs');const rename=fs.renameSync;fs.renameSync=(a,b)=>{const result=rename(a,b);if(a===process.env.TARGET&&b.includes('.fluffy-rollback-')){fs.writeFileSync(process.env.READY,b);process.kill(process.pid,'SIGKILL');}return result;};require('node:module').syncBuiltinESMExports();`,
      );
      const mime = path.join(f.bin, "xdg-mime");
      const previousMime = readFileSync(mime);
      writeFileSync(
        mime,
        `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='query')process.stdout.write('old.desktop');else if(process.argv[3]==='io.github.CateDesu.NyastraModManager.desktop'){fs.writeFileSync(process.env.TARGET+'.new',process.env.INDEPENDENT);fs.renameSync(process.env.TARGET+'.new',process.env.TARGET);process.exit(1);}`,
      );
      const ready = path.join(f.root, "claimed");
      const killed = spawnSync(
        process.execPath,
        ["--require", hook, installer, f.source, "--import-profile", source],
        {
          env: { ...f.env, TARGET: target, READY: ready, INDEPENDENT: independent },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      assert.equal(killed.signal, "SIGKILL", killed.stderr);
      const saved = readFileSync(ready, "utf8");
      assert.equal(readFileSync(saved, "utf8"), independent);
      assert.equal(existsSync(target), false);
      if (!journaled) rmSync(path.join(path.dirname(saved), "transaction.json"));
      writeFileSync(mime, previousMime);
      const retried = spawnSync(
        process.execPath,
        [installer, f.source, "--import-profile", source],
        { env: f.env, encoding: "utf8", timeout: 20000 },
      );
      if (journaled) {
        assert.equal(retried.status, 0, retried.stderr);
        assert.equal(readFileSync(target, "utf8"), independent);
      } else {
        assert.equal(retried.status, 1, retried.stderr);
        assert.match(retried.stderr, /--recover-fluffy/);
        assert.ok(retried.stderr.includes(saved));
        assert.equal(existsSync(target), false);
        assert.equal(readFileSync(saved, "utf8"), independent);
        const recovered = spawnSync(
          process.execPath,
          [installer, f.source, "--recover-fluffy", saved],
          { env: f.env, encoding: "utf8" },
        );
        assert.equal(recovered.status, 0, recovered.stderr);
        assert.equal(readFileSync(target, "utf8"), independent);
      }
      const success = journaled
        ? f.run()
        : spawnSync(process.execPath, [installer, f.source, "--import-profile", source], {
            env: f.env,
            encoding: "utf8",
          });
      assert.equal(success.status, 0, success.stderr);
      assert.equal(readFileSync(target, "utf8"), independent);
      assert.equal(readFileSync(saved, "utf8"), independent);
      assert.equal(readFileSync(original, "utf8"), '{"root":"original"}');
    } finally {
      f.clean();
    }
  });

test("legacy runtime recovery restores the chosen backup before a failed registration retry", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    const previous = path.join(path.dirname(f.app), ".app-previous-12345");
    const unrelated = path.join(path.dirname(f.app), ".app-previous-67890");
    mkdirSync(unrelated);
    writeFileSync(path.join(unrelated, "unrelated"), "keep");
    renameSync(f.app, previous);
    writeFileSync(path.join(f.source, "version"), "two");
    const failed = f.run(f.source, { FAIL_ASSOCIATION: "1" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /--recover-runtime/);
    assert.equal(existsSync(f.app), false);
    assert.equal(readFileSync(path.join(previous, "version"), "utf8"), "one");
    const recovered = spawnSync(
      process.execPath,
      [installer, f.source, "--recover-runtime", previous],
      { env: { ...f.env, FAIL_ASSOCIATION: "1" }, encoding: "utf8" },
    );
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(spawnSync(f.wrapper, [], { env: f.env }).status, 0);
    assert.equal(existsSync(previous), false);
    const retry = f.run(f.source, { FAIL_ASSOCIATION: "1" });
    assert.equal(retry.status, 1);
    assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "one");
    assert.equal(spawnSync(f.wrapper, [], { env: f.env }).status, 0);
    assert.equal(f.run().status, 0);
    assert.equal(readFileSync(path.join(f.app, "version"), "utf8"), "two");
    assert.equal(readFileSync(path.join(unrelated, "unrelated"), "utf8"), "keep");
  } finally {
    f.clean();
  }
});

for (const moveFails of [false, true]) {
  test(`legacy runtime recovery preserves a destination created just before publication, move fails=${moveFails}`, () => {
    const f = fixture();
    try {
      assert.equal(f.run().status, 0);
      const previous = path.join(path.dirname(f.app), ".app-previous-12345");
      renameSync(f.app, previous);
      const mv = path.join(f.bin, "mv");
      writeFileSync(
        mv,
        `#!/bin/sh
mkdir "$RECOVERY_APP" || exit 1
/usr/bin/mv "$@"
${moveFails ? 'echo "mv: not replacing destination" >&2; exit 1' : "exit 0"}
`,
      );
      chmodSync(mv, 0o755);
      const result = spawnSync(process.execPath, [installer, "--recover-runtime", previous], {
        env: { ...f.env, RECOVERY_APP: f.app },
        encoding: "utf8",
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /did not publish/);
      assert.deepEqual(readdirSync(f.app), []);
      assert.equal(readFileSync(path.join(previous, "version"), "utf8"), "one");
      const outside = spawnSync(process.execPath, [installer, "--recover-runtime", f.source], {
        env: f.env,
        encoding: "utf8",
      });
      assert.equal(outside.status, 1);
      assert.match(outside.stderr, /Choose an absolute/);
    } finally {
      f.clean();
    }
  });
}
