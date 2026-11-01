import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { importLinuxProfile } from "./import-linux-profile.mjs";

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
