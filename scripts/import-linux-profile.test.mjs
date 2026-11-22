import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { importLinuxProfile, recoverFluffyConfiguration } from "./import-linux-profile.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nyastra-import-"));
  const config = path.join(root, "config");
  const source = path.join(config, "Vortex");
  mkdirSync(path.join(source, "state.v2"), { recursive: true });
  writeFileSync(path.join(source, "state.v2/CURRENT"), "MANIFEST-000001\n");
  writeFileSync(path.join(source, "state.v2/LOCK"), "");
  writeFileSync(path.join(source, "state.v2/MANIFEST-000001"), "database fixture");
  mkdirSync(path.join(source, "plugins"));
  writeFileSync(path.join(source, "plugins/extension.js"), "extension fixture");
  mkdirSync(path.join(source, "downloads"));
  writeFileSync(path.join(source, "downloads/mod.zip"), "personal mod archive");
  writeFileSync(
    path.join(source, "startup.json"),
    JSON.stringify({
      userData: source,
      restore: "/backup",
      disableGPU: true,
      storeVersion: "2.9.0",
    }),
  );
  return { root, source, config, clean: () => rmSync(root, { recursive: true, force: true }) };
}

await test("copies profile metadata without moving mods or carrying startup redirects", () => {
  const f = fixture();
  try {
    const imported = importLinuxProfile(f.source, f.config);
    assert.equal(
      readFileSync(path.join(imported.profile, "state.v2/MANIFEST-000001"), "utf8"),
      "database fixture",
    );
    assert.equal(
      readFileSync(path.join(imported.profile, "plugins/extension.js"), "utf8"),
      "extension fixture",
    );
    assert.deepEqual(JSON.parse(readFileSync(path.join(imported.profile, "startup.json"))), {
      disableGPU: true,
      storeVersion: "2.9.0",
    });
    assert.ok(!existsSync(path.join(imported.profile, "downloads")));
    assert.equal(
      readFileSync(path.join(f.source, "downloads/mod.zip"), "utf8"),
      "personal mod archive",
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(imported.profile, "nyastra-import.json"))).source,
      f.source,
    );
    assert.throws(() => importLinuxProfile(f.source, f.config), /profile already exists/);
    imported.rollback();
    assert.ok(!existsSync(imported.profile));
    assert.ok(existsSync(path.join(f.source, "state.v2/CURRENT")));
  } finally {
    f.clean();
  }
});

await test("rollback leaves a replacement profile in place", () => {
  const f = fixture();
  try {
    const imported = importLinuxProfile(f.source, f.config);
    const saved = imported.profile + ".saved";
    fs.renameSync(imported.profile, saved);
    mkdirSync(imported.profile);
    writeFileSync(path.join(imported.profile, "keep"), "new profile");
    assert.throws(() => imported.rollback(), /preserved a replacement/);
    assert.equal(readFileSync(path.join(imported.profile, "keep"), "utf8"), "new profile");
    rmSync(imported.profile, { recursive: true });
    fs.renameSync(saved, imported.profile);
    imported.rollback();
    mkdirSync(imported.profile);
    imported.rollback();
    assert.ok(existsSync(imported.profile));
  } finally {
    f.clean();
  }
});

await test("refuses to copy a profile while its database lock file is open", () => {
  const f = fixture();
  const descriptor = openSync(path.join(f.source, "state.v2/LOCK"), "r");
  try {
    assert.throws(() => importLinuxProfile(f.source, f.config), /Close the program/);
    assert.ok(!existsSync(path.join(f.config, "NyastraModManager")));
  } finally {
    closeSync(descriptor);
    f.clean();
  }
});

await test("rejects symlinks and removes its partial profile", () => {
  const f = fixture();
  try {
    symlinkSync(path.join(f.source, "downloads"), path.join(f.source, "plugins/linked"));
    assert.throws(() => importLinuxProfile(f.source, f.config), /does not copy symlinks/);
    assert.ok(!existsSync(path.join(f.config, "NyastraModManager")));
    assert.ok(existsSync(path.join(f.source, "downloads/mod.zip")));
  } finally {
    f.clean();
  }
});

await test("preserves a staging directory owned by another import", () => {
  const f = fixture();
  try {
    const staging = path.join(f.config, `.nyastra-import-${process.pid}`);
    mkdirSync(staging);
    const saved = path.join(staging, "keep");
    writeFileSync(saved, "existing import");
    assert.throws(() => importLinuxProfile(f.source, f.config), { code: "EEXIST" });
    assert.equal(readFileSync(saved, "utf8"), "existing import");
    assert.ok(!existsSync(path.join(f.config, "NyastraModManager")));
  } finally {
    f.clean();
  }
});

await test("copies Fluffy configuration and rolls back only its own copy", () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.config, "vortex-native"));
    const original = path.join(f.config, "vortex-native/fluffy.json");
    writeFileSync(original, '{"sharedFluffyRoot":"/existing/Fluffy"}');
    const imported = importLinuxProfile(f.source, f.config);
    const copied = path.join(f.config, "nyastra-mod-manager/fluffy.json");
    assert.deepEqual(readFileSync(copied), readFileSync(original));
    imported.rollback();
    assert.ok(!existsSync(copied));
    assert.ok(existsSync(original));
  } finally {
    f.clean();
  }
});

function savedProfiles(f) {
  const files = {
    "skyrimse/profiles/first/settings.ini": "first config",
    "skyrimse/profiles/second/settings.ini": "second config",
    "skyrimse/profiles/second/saves/manual.sav": "saved game fixture",
    "another-game/profiles/third/config.json": "another game config",
    "skyrimse/mods/member/payload.txt": "staged mod",
    "skyrimse/cache/temporary": "unrelated cache",
  };
  for (const [relative, bytes] of Object.entries(files)) {
    const file = path.join(f.source, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  return files;
}

await test("discovers multiple game profile trees and preserves archive and staging locations", () => {
  const f = fixture();
  const files = savedProfiles(f);
  try {
    const imported = importLinuxProfile(f.source, f.config);
    for (const [relative, bytes] of Object.entries(files)) {
      assert.equal(readFileSync(path.join(f.source, relative), "utf8"), bytes);
      if (relative.includes("/profiles/")) {
        assert.ok(
          existsSync(path.join(imported.profile, relative)),
          `missing imported profile file: ${relative}`,
        );
        assert.equal(readFileSync(path.join(imported.profile, relative), "utf8"), bytes);
      } else {
        assert.equal(existsSync(path.join(imported.profile, relative)), false);
      }
    }
    assert.equal(existsSync(path.join(imported.profile, "downloads")), false);
    imported.rollback();
    assert.equal(existsSync(imported.profile), false);
    assert.equal(
      readFileSync(path.join(f.source, "skyrimse/profiles/second/settings.ini"), "utf8"),
      "second config",
    );
  } finally {
    f.clean();
  }
});

for (const relative of [
  "skyrimse",
  "skyrimse/profiles",
  "skyrimse/profiles/second",
  "skyrimse/profiles/second/saves/linked.sav",
]) {
  await test(`rejects a symlink in a discovered profile tree at ${relative} and permits a clean retry`, () => {
    const f = fixture();
    savedProfiles(f);
    const external = path.join(f.root, "external");
    mkdirSync(external);
    writeFileSync(path.join(external, "keep"), "external data");
    const linked = path.join(f.source, relative);
    try {
      rmSync(linked, { recursive: true, force: true });
      symlinkSync(external, linked);
      assert.throws(() => importLinuxProfile(f.source, f.config), /does not copy symlinks/);
      assert.equal(existsSync(path.join(f.config, "NyastraModManager")), false);
      assert.equal(existsSync(path.join(f.config, `.nyastra-import-${process.pid}`)), false);
      assert.equal(readFileSync(path.join(external, "keep"), "utf8"), "external data");
      rmSync(linked);
      savedProfiles(f);
      const imported = importLinuxProfile(f.source, f.config);
      assert.equal(
        readFileSync(path.join(imported.profile, "skyrimse/profiles/second/settings.ini"), "utf8"),
        "second config",
      );
      imported.rollback();
    } finally {
      f.clean();
    }
  });
}

await test("a native profile copy failure rolls back the transaction before a successful retry", () => {
  const f = fixture();
  savedProfiles(f);
  const denied = path.join(f.source, "skyrimse/profiles/second/settings.ini");
  try {
    chmodSync(denied, 0o000);
    assert.throws(() => importLinuxProfile(f.source, f.config), { code: "EACCES" });
    assert.equal(existsSync(path.join(f.config, "NyastraModManager")), false);
    assert.equal(existsSync(path.join(f.config, `.nyastra-import-${process.pid}`)), false);
    chmodSync(denied, 0o640);
    assert.equal(readFileSync(denied, "utf8"), "second config");
    const imported = importLinuxProfile(f.source, f.config);
    assert.equal(
      readFileSync(path.join(imported.profile, "skyrimse/profiles/second/settings.ini"), "utf8"),
      "second config",
    );
    imported.rollback();
  } finally {
    chmodSync(denied, 0o640);
    f.clean();
  }
});

await test("refuses to overwrite an existing import and preserves later edits", () => {
  const f = fixture();
  savedProfiles(f);
  try {
    const imported = importLinuxProfile(f.source, f.config);
    const edited = path.join(imported.profile, "skyrimse/profiles/second/settings.ini");
    writeFileSync(edited, "later edit");
    assert.throws(() => importLinuxProfile(f.source, f.config), /profile already exists/);
    assert.equal(readFileSync(edited, "utf8"), "later edit");
    assert.equal(
      readFileSync(path.join(f.source, "skyrimse/profiles/second/settings.ini"), "utf8"),
      "second config",
    );
  } finally {
    f.clean();
  }
});

await test("copies INI backups for imported game profiles without unrelated game data", () => {
  const f = fixture();
  savedProfiles(f);
  const files = {
    "skyrimse/Skyrim.ini": "global settings",
    "skyrimse/SkyrimPrefs.INI": "global preferences",
    "starfield/StarfieldCustom.ini": "global custom settings",
    "starfield/profiles/private/StarfieldCustom.ini": "private custom settings",
    "another-game/Custom.INI": "extension game global settings",
    "skyrimse/mods/payload.ini": "staged mod",
    "skyrimse/cache.ini/keep": "unrelated directory",
    "skyrimse/cache/temporary": "unrelated cache",
  };
  try {
    for (const [relative, bytes] of Object.entries(files)) {
      const filename = path.join(f.source, relative);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, bytes);
    }
    const imported = importLinuxProfile(f.source, f.config);
    for (const [relative, bytes] of Object.entries(files)) {
      assert.equal(readFileSync(path.join(f.source, relative), "utf8"), bytes);
      if (/^[^/]+\/[^/]+\.ini$/i.test(relative) || relative.includes("/profiles/"))
        assert.equal(readFileSync(path.join(imported.profile, relative), "utf8"), bytes);
      else assert.equal(existsSync(path.join(imported.profile, relative)), false);
    }
    imported.rollback();
    assert.equal(existsSync(imported.profile), false);
  } finally {
    f.clean();
  }
});

for (const directory of ["downloads", "cache", "unused-game"]) {
  for (const kind of ["regular", "symlink", "broken-symlink", "permission"]) {
    await test(`ignores an unrelated ${directory} INI ${kind} while preserving game backups`, () => {
      const f = fixture();
      savedProfiles(f);
      const unrelated = path.join(f.source, directory, "Skyrim.ini");
      const external = path.join(f.root, "external.ini");
      const global = path.join(f.source, "skyrimse/Skyrim.ini");
      try {
        mkdirSync(path.dirname(unrelated), { recursive: true });
        writeFileSync(external, "external settings");
        writeFileSync(global, "global settings");
        if (kind.includes("symlink"))
          symlinkSync(kind === "symlink" ? external : path.join(f.root, "absent.ini"), unrelated);
        else {
          writeFileSync(unrelated, "unrelated settings");
          if (kind === "permission") chmodSync(unrelated, 0);
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          const imported = importLinuxProfile(f.source, f.config);
          assert.equal(existsSync(path.join(imported.profile, directory)), false);
          assert.equal(
            readFileSync(path.join(imported.profile, "skyrimse/Skyrim.ini"), "utf8"),
            "global settings",
          );
          assert.equal(
            readFileSync(
              path.join(imported.profile, "skyrimse/profiles/first/settings.ini"),
              "utf8",
            ),
            "first config",
          );
          assert.equal(readFileSync(global, "utf8"), "global settings");
          assert.equal(readFileSync(external, "utf8"), "external settings");
          imported.rollback();
          assert.deepEqual(readdirSync(f.config), ["Vortex"]);
        }
        if (kind === "permission") chmodSync(unrelated, 0o600);
        if (!kind.includes("symlink"))
          assert.equal(readFileSync(unrelated, "utf8"), "unrelated settings");
      } finally {
        f.clean();
        assert.equal(existsSync(f.root), false);
      }
    });
  }
}

await test("a regular profiles file does not select unrelated INI backups", () => {
  const f = fixture();
  savedProfiles(f);
  try {
    mkdirSync(path.join(f.source, "cache"));
    writeFileSync(path.join(f.source, "cache/profiles"), "unrelated marker");
    symlinkSync(path.join(f.root, "absent.ini"), path.join(f.source, "cache/Skyrim.ini"));
    const imported = importLinuxProfile(f.source, f.config);
    assert.equal(existsSync(path.join(imported.profile, "cache")), false);
    assert.equal(
      readFileSync(path.join(imported.profile, "another-game/profiles/third/config.json"), "utf8"),
      "another game config",
    );
    imported.rollback();
    assert.deepEqual(readdirSync(f.config), ["Vortex"]);
  } finally {
    f.clean();
    assert.equal(existsSync(f.root), false);
  }
});

for (const failure of ["symlink", "broken-symlink", "permission"]) {
  await test(`rolls back an INI backup ${failure} failure and permits retry`, () => {
    const f = fixture();
    savedProfiles(f);
    const backup = path.join(f.source, "skyrimse/Skyrim.ini");
    const external = path.join(f.root, "keep.ini");
    writeFileSync(external, "external settings");
    try {
      const ignored = path.join(f.source, "downloads/Skyrim.ini");
      symlinkSync(path.join(f.root, "absent.ini"), ignored);
      if (failure.includes("symlink"))
        symlinkSync(failure === "symlink" ? external : path.join(f.root, "absent.ini"), backup);
      else {
        writeFileSync(backup, "global settings");
        chmodSync(backup, 0);
      }
      assert.throws(
        () => importLinuxProfile(f.source, f.config),
        failure.includes("symlink") ? /does not copy symlinks/ : { code: "EACCES" },
      );
      assert.equal(existsSync(path.join(f.config, "NyastraModManager")), false);
      assert.equal(existsSync(path.join(f.config, `.nyastra-import-${process.pid}`)), false);
      assert.equal(readFileSync(external, "utf8"), "external settings");
      if (failure.includes("symlink")) rmSync(backup);
      else chmodSync(backup, 0o600);
      writeFileSync(backup, "global settings");
      const imported = importLinuxProfile(f.source, f.config);
      assert.equal(existsSync(path.join(imported.profile, "downloads")), false);
      assert.equal(
        readFileSync(path.join(imported.profile, "skyrimse/Skyrim.ini"), "utf8"),
        "global settings",
      );
      imported.rollback();
      assert.deepEqual(readdirSync(f.config), ["Vortex"]);
    } finally {
      f.clean();
      assert.equal(existsSync(f.root), false);
    }
  });
}

for (const alias of [false, true]) {
  await test(`imports authoritative INI ownership and rebases pending user data paths, alias=${alias}`, () => {
    const f = fixture();
    try {
      savedProfiles(f);
      const profile = { id: "first", gameId: "skyrimse", features: { local_game_settings: true } };
      const external = path.join(f.root, "documents/My Games/Skyrim Special Edition");
      const record = {
        version: 1,
        installed: { skyrimse: profile },
        pending: {
          oldProfile: profile,
          newProfile: { ...profile, features: { local_game_settings: false } },
          completed: 0,
          steps: [
            {
              sourcePath: external,
              destinationPath: path.join(f.source, "skyrimse/profiles/first"),
              files: [{ name: "Skyrim.ini", optional: false }],
              copyType: "GloPro",
            },
            {
              sourcePath: path.join(f.source, "skyrimse"),
              destinationPath: external,
              files: [{ name: "Skyrim.ini", optional: false }],
              copyType: "BacGlo",
            },
          ],
        },
      };
      const filename = path.join(f.source, "local-game-settings.json");
      const bytes = JSON.stringify(record);
      writeFileSync(filename, bytes);
      const selected = alias ? path.join(f.root, "profile-alias") : f.source;
      if (alias) symlinkSync(f.source, selected);
      const imported = importLinuxProfile(selected, f.config);
      const copied = JSON.parse(
        readFileSync(path.join(imported.profile, "local-game-settings.json")),
      );
      assert.deepEqual(copied.installed, record.installed);
      assert.equal(copied.pending.steps[0].sourcePath, external);
      assert.equal(
        copied.pending.steps[0].destinationPath,
        path.join(imported.profile, "skyrimse/profiles/first"),
      );
      assert.equal(copied.pending.steps[1].sourcePath, path.join(imported.profile, "skyrimse"));
      assert.equal(copied.pending.steps[1].destinationPath, external);
      assert.equal(readFileSync(filename, "utf8"), bytes);
    } finally {
      f.clean();
    }
  });
}

for (const invalid of [
  "",
  "{",
  JSON.stringify({ version: 2, installed: {} }),
  JSON.stringify({ version: 1, installed: { skyrimse: { id: "p", gameId: "other" } } }),
  JSON.stringify({ version: 1, installed: {}, pending: { steps: [], completed: -1 } }),
]) {
  await test(`rejects invalid INI ownership without publishing an import: ${invalid}`, () => {
    const f = fixture();
    try {
      writeFileSync(path.join(f.source, "local-game-settings.json"), invalid);
      assert.throws(() => importLinuxProfile(f.source, f.config));
      assert.ok(!existsSync(path.join(f.config, "NyastraModManager")));
      assert.equal(readFileSync(path.join(f.source, "local-game-settings.json"), "utf8"), invalid);
    } finally {
      f.clean();
    }
  });
}

await test("a failed Fluffy copy leaves no partial configuration and import can retry", () => {
  const f = fixture();
  const originalCopy = fs.cpSync;
  const oldFluffy = path.join(f.config, "vortex-native/fluffy.json");
  const fluffy = path.join(f.config, "nyastra-mod-manager/fluffy.json");
  const contents = '{"sharedFluffyRoot":"/fixture/Fluffy"}';
  try {
    mkdirSync(path.dirname(oldFluffy), { recursive: true });
    writeFileSync(oldFluffy, contents);
    fs.cpSync = (source, destination, options) => {
      if (source === oldFluffy) {
        writeFileSync(destination, '{"shared');
        throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
      }
      return originalCopy(source, destination, options);
    };
    syncBuiltinESMExports();
    assert.throws(() => importLinuxProfile(f.source, f.config), /fixture disk full/);
    assert.equal(existsSync(fluffy), false);
    assert.equal(existsSync(path.join(f.config, "NyastraModManager")), false);
    assert.equal(readFileSync(oldFluffy, "utf8"), contents);
    fs.cpSync = originalCopy;
    syncBuiltinESMExports();
    importLinuxProfile(f.source, f.config);
    assert.equal(readFileSync(fluffy, "utf8"), contents);
    assert.deepEqual(readdirSync(path.dirname(fluffy)), ["fluffy.json"]);
    assert.deepEqual(
      readdirSync(f.config).sort(),
      ["NyastraModManager", "Vortex", "nyastra-mod-manager", "vortex-native"].sort(),
    );
  } finally {
    fs.cpSync = originalCopy;
    syncBuiltinESMExports();
    f.clean();
  }
});

await test("Fluffy publication preserves configuration created during import", () => {
  const f = fixture();
  const originalLink = fs.linkSync;
  const oldFluffy = path.join(f.config, "vortex-native/fluffy.json");
  const fluffy = path.join(f.config, "nyastra-mod-manager/fluffy.json");
  try {
    mkdirSync(path.dirname(oldFluffy), { recursive: true });
    writeFileSync(oldFluffy, "source configuration");
    fs.linkSync = (source, destination) => {
      assert.equal(destination, fluffy);
      assert.equal(readFileSync(source, "utf8"), "source configuration");
      writeFileSync(fluffy, "new configuration", { flag: "wx" });
      return originalLink(source, destination);
    };
    syncBuiltinESMExports();
    assert.throws(() => importLinuxProfile(f.source, f.config), { code: "EEXIST" });
    assert.equal(readFileSync(fluffy, "utf8"), "new configuration");
    assert.equal(readFileSync(oldFluffy, "utf8"), "source configuration");
    assert.equal(existsSync(path.join(f.config, "NyastraModManager")), false);
    assert.deepEqual(readdirSync(path.dirname(fluffy)), ["fluffy.json"]);
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
    f.clean();
  }
});

for (const replacement of ["file", "symlink", "dangling", "edit"]) {
  await test(`rollback preserves independent Fluffy ${replacement} after publication`, () => {
    const f = fixture();
    try {
      const original = path.join(f.config, "vortex-native/fluffy.json");
      const target = path.join(f.config, "nyastra-mod-manager/fluffy.json");
      mkdirSync(path.dirname(original));
      writeFileSync(original, '{"sharedFluffyRoot":"/original"}');
      const imported = importLinuxProfile(f.source, f.config);
      const other = path.join(f.root, "independent.json");
      if (replacement !== "dangling") writeFileSync(other, '{"sharedFluffyRoot":"/independent"}');
      if (replacement === "edit") writeFileSync(target, readFileSync(other));
      else {
        const pending = `${target}.replacement`;
        if (replacement === "file") writeFileSync(pending, readFileSync(other));
        else symlinkSync(other, pending);
        fs.renameSync(pending, target);
      }
      imported.rollback();
      if (["symlink", "dangling"].includes(replacement))
        assert.equal(fs.readlinkSync(target), other);
      if (replacement !== "dangling")
        assert.equal(readFileSync(target, "utf8"), '{"sharedFluffyRoot":"/independent"}');
      assert.equal(readFileSync(original, "utf8"), '{"sharedFluffyRoot":"/original"}');
      const claims = readdirSync(path.dirname(target)).filter((name) =>
        name.startsWith(".fluffy-rollback-"),
      );
      assert.equal(claims.length, 1);
      assert.equal(
        lstatSync(path.join(path.dirname(target), claims[0], "fluffy.json")).ino,
        lstatSync(target).ino,
      );
      assert.equal(existsSync(path.join(f.config, "NyastraModManager")), false);
    } finally {
      f.clean();
    }
  });
}

for (const replacedBeforeClaim of [false, true]) {
  await test(`replacement at rollback ownership inspection survives, prior replacement=${replacedBeforeClaim}`, () => {
    const f = fixture();
    const originalLstat = fs.lstatSync;
    let reached = false;
    try {
      const original = path.join(f.config, "vortex-native/fluffy.json");
      const target = path.join(f.config, "nyastra-mod-manager/fluffy.json");
      mkdirSync(path.dirname(original));
      writeFileSync(original, '{"sharedFluffyRoot":"/original"}');
      const imported = importLinuxProfile(f.source, f.config);
      const replace = (bytes) => {
        writeFileSync(`${target}.replacement`, bytes);
        fs.renameSync(`${target}.replacement`, target);
      };
      const prior = '{"sharedFluffyRoot":"/prior-independent"}';
      const late = '{"sharedFluffyRoot":"/at-inspection"}';
      if (replacedBeforeClaim) replace(prior);
      fs.lstatSync = (filename, ...args) => {
        if (
          !reached &&
          String(filename).includes(".fluffy-rollback-") &&
          String(filename).endsWith("/fluffy.json")
        ) {
          reached = true;
          replace(late);
        }
        return originalLstat(filename, ...args);
      };
      syncBuiltinESMExports();
      if (replacedBeforeClaim) {
        assert.throws(() => imported.rollback(), /Independent Fluffy configuration preserved at/);
        const directories = readdirSync(path.dirname(target)).filter((name) =>
          name.startsWith(".fluffy-rollback-"),
        );
        assert.equal(directories.length, 1);
        assert.equal(
          readFileSync(path.join(path.dirname(target), directories[0], "fluffy.json"), "utf8"),
          prior,
        );
      } else imported.rollback();
      assert.equal(reached, true, "production rollback reached its ownership inspection");
      assert.equal(readFileSync(target, "utf8"), late);
      assert.equal(readFileSync(original, "utf8"), '{"sharedFluffyRoot":"/original"}');
      assert.equal(existsSync(path.join(f.config, "NyastraModManager")), false);
    } finally {
      fs.lstatSync = originalLstat;
      syncBuiltinESMExports();
      f.clean();
    }
  });
}

await test("rollback preserves Fluffy when ownership inspection fails", () => {
  const f = fixture();
  const originalLstat = fs.lstatSync;
  let injected = false;
  try {
    const original = path.join(f.config, "vortex-native/fluffy.json");
    const target = path.join(f.config, "nyastra-mod-manager/fluffy.json");
    mkdirSync(path.dirname(original));
    writeFileSync(original, '{"sharedFluffyRoot":"/original"}');
    const imported = importLinuxProfile(f.source, f.config);
    fs.lstatSync = (filename, ...args) => {
      if (
        !injected &&
        String(filename).includes(".fluffy-rollback-") &&
        String(filename).endsWith("/fluffy.json")
      ) {
        injected = true;
        throw Object.assign(new Error("fixture inspection failure"), { code: "EACCES" });
      }
      return originalLstat(filename, ...args);
    };
    syncBuiltinESMExports();
    imported.rollback();
    assert.equal(injected, true);
    assert.equal(readFileSync(target, "utf8"), '{"sharedFluffyRoot":"/original"}');
    assert.equal(existsSync(path.join(f.config, "NyastraModManager")), false);
  } finally {
    fs.lstatSync = originalLstat;
    syncBuiltinESMExports();
    f.clean();
  }
});

test("rollback retains an independent edit through an already open descriptor after ownership read", () => {
  const f = fixture();
  const source = f.source;
  let fd;
  const originalRead = fs.readFileSync;
  try {
    mkdirSync(path.join(source, "state.v2"), { recursive: true });
    writeFileSync(path.join(source, "state.v2/CURRENT"), "M");
    writeFileSync(path.join(source, "state.v2/LOCK"), "");
    const original = path.join(f.config, "vortex-native/fluffy.json");
    const target = path.join(f.config, "nyastra-mod-manager/fluffy.json");
    mkdirSync(path.dirname(original), { recursive: true });
    writeFileSync(original, '{"root":"original"}');
    const imported = importLinuxProfile(source, f.config);
    fd = fs.openSync(target, "r+");
    const independent = '{"root":"independent edit"}';
    let reached = false;
    fs.readFileSync = (name, ...args) => {
      const result = originalRead(name, ...args);
      if (!reached && String(name).includes(".fluffy-rollback-")) {
        reached = true;
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, independent, 0, "utf8");
      }
      return result;
    };
    syncBuiltinESMExports();
    imported.rollback();
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    const privateDirs = readdirSync(path.dirname(target)).filter((x) =>
      x.startsWith(".fluffy-rollback-"),
    );
    const openBytes = originalRead(fd, "utf8");
    const linked = fs.fstatSync(fd).nlink;

    assert.ok(reached);
    assert.ok(
      existsSync(target) || privateDirs.length,
      "independent bytes must retain a directory entry after rollback",
    );
    const saved = path.join(path.dirname(target), privateDirs[0], "fluffy.json");
    assert.equal(originalRead(saved, "utf8"), independent);
    assert.ok(linked > 0);
    recoverFluffyConfiguration(f.config, saved);
    assert.equal(originalRead(target, "utf8"), independent);
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, "late edit after recovery", 0, "utf8");
    assert.equal(originalRead(target, "utf8"), "late edit after recovery");
    assert.equal(originalRead(saved, "utf8"), "late edit after recovery");
    importLinuxProfile(source, f.config);
    assert.equal(originalRead(target, "utf8"), "late edit after recovery");
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    if (fd !== undefined) fs.closeSync(fd);
    f.clean();
  }
});

await test("Fluffy recovery refuses a competing destination and preserves the saved inode", () => {
  const f = fixture();
  try {
    const directory = path.join(f.config, "nyastra-mod-manager");
    mkdirSync(directory);
    const claim = mkdtempSync(path.join(directory, ".fluffy-rollback-"));
    const saved = path.join(claim, "fluffy.json");
    writeFileSync(saved, "saved configuration");
    const target = path.join(directory, "fluffy.json");
    symlinkSync("missing-independent", target);
    assert.throws(() => recoverFluffyConfiguration(f.config, saved), { code: "EEXIST" });
    assert.equal(fs.readlinkSync(target), "missing-independent");
    assert.equal(readFileSync(saved, "utf8"), "saved configuration");
    assert.throws(
      () => recoverFluffyConfiguration(f.config, path.join(f.root, "fluffy.json")),
      /Choose a saved/,
    );
  } finally {
    f.clean();
  }
});

await test("claim recovery refuses a saved entry replaced after rollback", () => {
  const f = fixture();
  try {
    const original = path.join(f.config, "vortex-native/fluffy.json");
    mkdirSync(path.dirname(original));
    writeFileSync(original, "original");
    const imported = importLinuxProfile(f.source, f.config);
    imported.rollback();
    const directory = path.join(f.config, "nyastra-mod-manager");
    const claim = readdirSync(directory).find((name) => name.startsWith(".fluffy-rollback-"));
    const saved = path.join(directory, claim, "fluffy.json");
    writeFileSync(saved + ".replacement", "independent configuration");
    fs.renameSync(saved + ".replacement", saved);
    assert.throws(() => importLinuxProfile(f.source, f.config), /--recover-fluffy/);
    assert.equal(readFileSync(saved, "utf8"), "independent configuration");
    assert.equal(existsSync(path.join(directory, "fluffy.json")), false);
    recoverFluffyConfiguration(f.config, saved);
    assert.equal(
      readFileSync(path.join(directory, "fluffy.json"), "utf8"),
      "independent configuration",
    );
  } finally {
    f.clean();
  }
});
