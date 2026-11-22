import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeExtensionState } from "../../test-utils/builders";
import { hasUnresolvedExtensionImport, isProfileExtensionPath } from "./importedExtensionPaths";

const fixture = vi.hoisted(() => ({ profile: "" }));
vi.mock("../../util/getVortexPath", () => ({ default: () => fixture.profile }));
import ExtensionManager from "../../ExtensionManager";
import { recordReplacement, releaseReplacement } from "./replacementRecovery";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nyastra-import-lifecycle-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function database(seed: Record<string, unknown>) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  let snapshot: Map<string, string>;
  return {
    read: <T>(key: string): T => JSON.parse(values.get(key)!) as T,
    persistor: {
      getAllKVs: async () => [...values].map(([key, value]) => ({ key: key.split("###"), value })),
      removeItem: async (key: string[]) => {
        const prefix = key.join("###");
        for (const stored of values.keys())
          if (stored === prefix || stored.startsWith(prefix + "###")) values.delete(stored);
      },
      setItem: async (key: string[], value: string) => {
        values.set(key.join("###"), value);
      },
      beginTransaction: async () => {
        snapshot = new Map(values);
      },
      commitTransaction: async () => {},
      rollbackTransaction: async () => {
        values.clear();
        for (const [key, value] of snapshot) values.set(key, value);
      },
    },
  };
}

async function importModules() {
  const script = path.resolve(__dirname, "../../../../../scripts/import-linux-profile.mjs");
  const main = path.resolve(__dirname, "../../../../main/src/profileImport.ts");
  const importer = (await import(script)) as {
    importLinuxProfile(source: string, config: string): { profile: string };
  };
  const finalizer = (await import(main)) as {
    finishProfileImport(
      persistor: ReturnType<typeof database>["persistor"],
      userData: string,
    ): Promise<void>;
  };
  return { ...importer, ...finalizer };
}

type Catalog = Record<string, ReturnType<typeof makeExtensionState>>;
function scanner(profile: string, catalog: Catalog) {
  fixture.profile = profile;
  return Object.assign(Object.create(ExtensionManager.prototype) as object, {
    mExtensionState: catalog,
    mExtensionFormats: ["index.js"],
    mPendingAdds: [],
    mPendingRemoves: [] as string[],
    mOutdated: [],
    mLoadFailures: {},
    loadDynamicExtension: vi.fn((location: string) => ({
      name: "example",
      path: location,
      info: { version: "1.0.0" },
    })),
  }) as unknown as {
    loadUserExtensions: (loaded: Set<string>, previous: unknown[]) => unknown[];
    loadDynamicExtension: ReturnType<typeof vi.fn>;
    mPendingRemoves: string[];
    removePendingExtensions(): void;
    mExtensionState: Catalog;
  };
}

async function imported(
  identity: "direct" | "captured" | "legacy",
  aliasState: "unchanged" | "retarget" | "missing",
  copy: "present" | "missing" | "symlink" = "present",
  remove = false,
  oldCompletion = false,
) {
  const { importLinuxProfile, finishProfileImport } = await importModules();
  const original = path.join(root, "original");
  const alias = path.join(root, "alias");
  const other = path.join(root, "other");
  const config = path.join(root, "config");
  for (const directory of [original, other]) {
    mkdirSync(path.join(directory, "state.v2"), { recursive: true });
    writeFileSync(path.join(directory, "state.v2", "CURRENT"), "MANIFEST\n");
    writeFileSync(path.join(directory, "state.v2", "LOCK"), "");
  }
  const sourcePlugin = path.join(original, "plugins", "example");
  mkdirSync(sourcePlugin, { recursive: true });
  const code = "module.exports = function () { return true; };\n";
  writeFileSync(path.join(sourcePlugin, "index.js"), code);
  writeFileSync(
    path.join(sourcePlugin, "info.json"),
    JSON.stringify({ id: "example", name: "example", version: "1.0.0" }),
  );
  symlinkSync(original, alias);
  mkdirSync(config);
  const { profile } = importLinuxProfile(identity === "direct" ? original : alias, config);
  const pendingMarker = path.join(profile, "nyastra-import.json");
  const marker = path.join(profile, "nyastra-import-complete.json");
  const record = JSON.parse(readFileSync(pendingMarker, "utf8")) as {
    version: number;
    sourceCanonical?: string;
    extensionPathsVersion?: number;
  };
  if (identity === "legacy") delete record.sourceCanonical;
  record.version = 2;
  if (oldCompletion) record.extensionPathsVersion = 1;
  unlinkSync(pendingMarker);
  writeFileSync(marker, JSON.stringify(record));
  if (aliasState !== "unchanged") unlinkSync(alias);
  if (aliasState === "retarget") symlinkSync(other, alias);
  const copied = path.join(profile, "plugins", "example");
  if (copy !== "present") rmSync(copied, { recursive: true });
  if (copy === "symlink") symlinkSync(sourcePlugin, copied);
  const db = database({
    "app###extensions###old###path": sourcePlugin,
    "app###extensions###old###enabled": false,
    "app###extensions###old###remove": remove,
    "app###extensions###external###path": "/external/plugins/example",
    "settings###gameMode###discovered###game###extensionPath": sourcePlugin,
    "settings###mods###installPath###game": "/external/staging",
    "confidential###token": "current-login",
    "app###instanceId": "owner",
  });
  await finishProfileImport(db.persistor, profile);
  const catalog = {
    old: makeExtensionState({
      path: db.read<string>("app###extensions###old###path"),
      enabled: db.read<boolean>("app###extensions###old###enabled"),
      remove: db.read<boolean>("app###extensions###old###remove"),
    }),
  };
  expect(db.read("app###extensions###external###path")).toBe("/external/plugins/example");
  expect(db.read("settings###mods###installPath###game")).toBe("/external/staging");
  expect(db.read("confidential###token")).toBe("current-login");
  expect(db.read("app###instanceId")).toBe("owner");
  return { profile, sourcePlugin, copied, catalog, marker, db, code, finishProfileImport };
}

it.each(["unchanged", "retarget", "missing"] as const)(
  "retains legacy disable intent after the alias is %s without inventing historical identity",
  async (aliasState) => {
    const { profile, sourcePlugin, copied, catalog, marker, code } = await imported(
      "legacy",
      aliasState,
    );
    const instance = scanner(profile, catalog);
    expect(instance.loadUserExtensions(new Set(), [])).toEqual([]);
    expect(instance.loadDynamicExtension).not.toHaveBeenCalled();
    expect(instance.mPendingRemoves).toEqual([]);
    expect(catalog.old.path).toBe(sourcePlugin);
    expect(JSON.parse(readFileSync(marker, "utf8"))).not.toHaveProperty("sourceCanonical");
    expect(hasUnresolvedExtensionImport(profile)).toBe(true);
    expect(readFileSync(path.join(sourcePlugin, "index.js"), "utf8")).toBe(code);
    expect(readFileSync(path.join(copied, "index.js"), "utf8")).toBe(code);
  },
);

it.each(["unchanged", "retarget", "missing"] as const)(
  "repairs captured canonical paths after the alias is %s",
  async (aliasState) => {
    const { profile, copied, catalog, db } = await imported("captured", aliasState);
    expect(catalog.old.path).toBe(copied);
    expect(db.read("settings###gameMode###discovered###game###extensionPath")).toBe(copied);
    expect(hasUnresolvedExtensionImport(profile)).toBe(false);
    expect(scanner(profile, catalog).loadUserExtensions(new Set(), [])).toEqual([]);
  },
);

it.each(["present", "missing", "symlink"] as const)(
  "preserves the original and removal intent when the imported copy is %s",
  async (copy) => {
    const { profile, sourcePlugin, copied, catalog, code, db, finishProfileImport } =
      await imported("direct", "unchanged", copy, true);
    const instance = scanner(profile, catalog);
    instance.removePendingExtensions();
    expect(instance.mPendingRemoves).toEqual(copy === "present" ? ["old"] : []);
    expect(readFileSync(path.join(sourcePlugin, "index.js"), "utf8")).toBe(code);
    expect(catalog.old.remove).toBe(true);
    expect(scanner(profile, catalog).loadUserExtensions(new Set(), [])).toEqual([]);
    expect(hasUnresolvedExtensionImport(profile)).toBe(copy !== "present");
    if (copy === "symlink") expect(lstatSync(copied).isSymbolicLink()).toBe(true);
    else expect(existsSync(copied)).toBe(false);
    if (copy !== "present") {
      if (copy === "symlink") unlinkSync(copied);
      mkdirSync(copied);
      await finishProfileImport(db.persistor, profile);
      expect(db.read("app###extensions###old###path")).toBe(copied);
      expect(db.read("app###extensions###old###remove")).toBe(true);
      expect(hasUnresolvedExtensionImport(profile)).toBe(false);
    }
  },
);

it("rechecks an old completion bit without trusting a retargeted legacy alias", async () => {
  const { profile, catalog } = await imported("legacy", "retarget", "present", false, true);
  expect(hasUnresolvedExtensionImport(profile)).toBe(true);
  expect(scanner(profile, catalog).loadUserExtensions(new Set(), [])).toEqual([]);
});

describe("extension discovery and removal", () => {
  beforeEach(() => {
    mkdirSync(path.join(root, "plugins", "copied"), { recursive: true });
  });
  it.each([1, 2])(
    "retains disabled legacy version %s rows and skips untracked copied code",
    (version) => {
      writeFileSync(
        path.join(root, "nyastra-import-complete.json"),
        JSON.stringify({ version, source: path.join(root, "missing-alias") }),
      );
      const instance = scanner(root, {
        disabled: makeExtensionState({
          path: path.join(root, "lost-source", "plugins", "copied"),
          enabled: false,
        }),
      });
      expect(instance.loadUserExtensions(new Set(), [])).toEqual([]);
      expect(instance.mPendingRemoves).toEqual([]);
      expect(instance.loadDynamicExtension).not.toHaveBeenCalled();
      expect(instance.mExtensionState.disabled.enabled).toBe(false);
    },
  );
  it("honors current paths while a legacy import remains unresolved", () => {
    writeFileSync(
      path.join(root, "nyastra-import-complete.json"),
      JSON.stringify({ version: 2, source: path.join(root, "missing-alias") }),
    );
    const instance = scanner(root, {
      disabled: makeExtensionState({
        path: path.join(root, "lost-source", "plugins", "copied"),
        enabled: false,
      }),
    });
    instance.mExtensionState.disabled = makeExtensionState({
      path: path.join(root, "plugins", "copied"),
      enabled: true,
    });
    expect(instance.loadUserExtensions(new Set(), [])).toHaveLength(1);
  });
  it.each([false, true])(
    "keeps ordinary scanning and missing-row removal, repaired %s",
    (repaired) => {
      if (repaired)
        writeFileSync(
          path.join(root, "nyastra-import-complete.json"),
          JSON.stringify({ version: 2, extensionPathsVersion: 2 }),
        );
      const instance = scanner(root, {
        disabled: makeExtensionState({
          path: path.join(root, "lost-source", "plugins", "copied"),
          enabled: false,
        }),
      });
      expect(instance.loadUserExtensions(new Set(), [])).toHaveLength(1);
      expect(instance.mPendingRemoves).toEqual(["disabled"]);
    },
  );

  it.each(["ordinary", "legacy", 1, 2])(
    "respects extension removal ownership for %s",
    (version) => {
      if (version !== "ordinary")
        writeFileSync(
          path.join(root, "nyastra-import-complete.json"),
          JSON.stringify({
            version: 2,
            extensionPathsVersion: version === "legacy" ? undefined : version,
          }),
        );
      const original = path.join(root, "source", "example");
      mkdirSync(original, { recursive: true });
      writeFileSync(path.join(original, "index.js"), "source bytes");
      const current = path.join(root, "plugins", "copied");
      const instance = scanner(root, {
        original: makeExtensionState({ path: original, remove: true }),
        current: makeExtensionState({ path: current, remove: true }),
      });
      instance.removePendingExtensions();
      expect(existsSync(current)).toBe(false);
      expect(instance.mPendingRemoves).toEqual(
        version === "ordinary" ? ["original", "current"] : ["current"],
      );
      if (version !== "ordinary")
        expect(readFileSync(path.join(original, "index.js"), "utf8")).toBe("source bytes");
    },
  );
  it("honors a disabled catalog entry when scanning through an alias", () => {
    const alias = path.join(root, "alias");
    symlinkSync(root, alias);
    const instance = scanner(alias, {
      disabled: makeExtensionState({
        path: path.join(root, "plugins", "copied"),
        enabled: false,
      }),
    });
    expect(instance.loadUserExtensions(new Set(), [])).toEqual([]);
    expect(instance.loadDynamicExtension).not.toHaveBeenCalled();
  });

  it("leaves replacement journals in a linked source plugins directory alone", () => {
    const original = path.join(root, "plugins");
    const copied = path.join(original, "copied");
    const candidate = path.join(original, ".extension-new.installing");
    const previous = path.join(original, ".extension.bak-old");
    mkdirSync(candidate);
    const extension = makeExtensionState({ path: copied });
    releaseReplacement(
      recordReplacement(original, copied, previous, candidate, { extension }, extension),
    );
    const profile = path.join(root, "import");
    mkdirSync(profile);
    symlinkSync(original, path.join(profile, "plugins"));
    writeFileSync(
      path.join(profile, "nyastra-import-complete.json"),
      '{"version":2,"extensionPathsVersion":2}',
    );
    const instance = scanner(profile, {});
    instance.removePendingExtensions();
    expect(instance.loadUserExtensions(new Set(), [])).toEqual([]);
    expect(existsSync(copied)).toBe(true);
    expect(existsSync(previous)).toBe(false);
  });

  it("preserves a competing extension when startup uses a profile alias", () => {
    const alias = path.join(root, "profile-link");
    symlinkSync(root, alias);
    const plugins = path.join(alias, "plugins");
    const destination = path.join(plugins, "copied");
    const previous = path.join(plugins, ".extension.bak-old");
    const candidate = path.join(plugins, ".extension-new.installing");
    mkdirSync(candidate);
    const old = makeExtensionState({ path: destination });
    releaseReplacement(
      recordReplacement(
        plugins,
        destination,
        previous,
        candidate,
        { old },
        { ...old, version: "2" },
      ),
    );
    renameSync(destination, previous);
    mkdirSync(destination);
    writeFileSync(path.join(destination, "keep"), "competitor");
    const instance = scanner(alias, { old });
    expect(instance.loadUserExtensions(new Set(), [])).toEqual([]);
    instance.mExtensionState.old = { ...old, remove: true };
    instance.removePendingExtensions();
    expect(readFileSync(path.join(destination, "keep"), "utf8")).toBe("competitor");
    expect(instance.mPendingRemoves).toEqual([]);
  });
  it.each(["leaf", "intermediate", "root"])("rejects a %s symlink to the source", (kind) => {
    const original = path.join(root, "source");
    mkdirSync(path.join(original, "copied"), { recursive: true });
    const plugins = path.join(root, "plugins");
    rmSync(plugins, { recursive: true });
    if (kind === "root") symlinkSync(original, plugins);
    else {
      mkdirSync(plugins);
      symlinkSync(original, path.join(plugins, kind === "leaf" ? "copied" : "bridge"));
    }
    expect(
      isProfileExtensionPath(
        root,
        path.join(plugins, ...(kind === "intermediate" ? ["bridge", "copied"] : ["copied"])),
      ),
    ).toBe(false);
  });
});
