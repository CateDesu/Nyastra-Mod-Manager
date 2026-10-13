import assert from "node:assert/strict";
import {
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

test("copies profile metadata without moving mods or carrying startup redirects", () => {
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

test("refuses to copy a profile while its database lock file is open", () => {
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

test("rejects symlinks and removes its partial profile", () => {
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

test("copies Fluffy configuration and rolls back only its own copy", () => {
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
