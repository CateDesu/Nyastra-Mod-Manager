import { statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import type { types } from "@nexusmods/vortex-api";
import Bluebird from "bluebird";
import { types as actionTypes } from "redux-act";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ paths: {} as Record<string, string> }));

const requireForTest = createRequire(import.meta.url);
const parserPath = requireForTest.resolve("vortex-parse-ini");
const originalParser = requireForTest.cache[parserPath];
beforeAll(async () => {
  // The legacy require needs the same transformed source as the ESM imports.
  requireForTest.cache[parserPath] = { exports: await import("vortex-parse-ini") } as NodeJS.Module;
});
afterAll(() => {
  if (originalParser) requireForTest.cache[parserPath] = originalParser;
  else delete requireForTest.cache[parserPath];
});

vi.mock("@nexusmods/vortex-api", async (importOriginal) => {
  const base = await importOriginal<any>();
  const React = await import("react");
  return {
    ...base,
    ComponentEx: React.Component,
    actions: {},
    fs: {
      statSync,
      statAsync: (file: string) => Bluebird.resolve(stat(file)),
      readdirAsync: (file: string) => Bluebird.resolve(readdir(file)),
      readFileAsync: (file: string, options: any) => Bluebird.resolve(readFile(file, options)),
      writeFileAsync: (file: string, data: string, options: any) =>
        Bluebird.resolve(writeFile(file, data, options)),
      ensureDirWritableAsync: (file: string) => Bluebird.resolve(mkdir(file, { recursive: true })),
      copyAsync: (source: string, destination: string) =>
        Bluebird.resolve(copyFile(source, destination)),
      removeAsync: (file: string) => Bluebird.resolve(rm(file, { recursive: true, force: true })),
    },
    selectors: {
      discoveryByGame: (state: any, id: string) => state.settings.gameMode.discovered[id],
      gameById: () => ({}),
      activeProfile: (state: any) => state.persistent.profiles.profile,
      activeGameId: () => "witcher3",
      lastActiveProfileForGame: () => "profile",
      profileById: (state: any, id: string) => state.persistent.profiles[id],
      installPathForGame: (state: any) => state.staging,
    },
    util: {
      ...base.util,
      getVortexPath: (name: string) => {
        if (!runtime.paths[name]) throw new Error(`Unexpected host path: ${name}`);
        return runtime.paths[name];
      },
      getSafe: (value: any, keys: string[], fallback: unknown) =>
        keys.reduce((entry, key) => entry?.[key], value) ?? fallback,
      opn: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    },
  };
});

vi.mock("./scriptmerger", () => ({
  repairStaleScriptMerger: async () => undefined,
  downloadScriptMerger: async () => undefined,
  getScriptMergerDir: async () => undefined,
  getMergedModName: async () => "mod0000_MergedFiles",
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function put(file: string, data: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    (err) => (err.code === "ENOENT" ? false : Promise.reject(err)),
  );
}

async function fixture(proton = true) {
  actionTypes.clear();
  vi.resetModules();
  const root = await mkdtemp(path.join(tmpdir(), "nyastra-w3-paths-"));
  roots.push(root);
  runtime.paths = {
    documents: path.join(root, "host-documents"),
    userData: path.join(root, "user-data"),
  };
  const prefix = path.join(root, "compatdata", "292030", "pfx");
  const documents = path.join(prefix, "drive_c", "users", "steamuser", "Documents");
  const host = path.join(runtime.paths.documents, "The Witcher 3");
  const target = path.join(proton ? documents : runtime.paths.documents, "The Witcher 3");
  const discovery = { path: path.join(root, "game"), ...(proton ? { protonPrefix: prefix } : {}) };
  const state = {
    staging: path.join(root, "staging"),
    settings: { gameMode: { discovered: { witcher3: discovery } }, witcher3: {} },
    persistent: {
      profiles: {
        profile: {
          id: "profile",
          gameId: "witcher3",
          modState: {},
          features: { local_merges: true },
        },
        incoming: { id: "incoming", gameId: "witcher3", features: {} },
      },
      mods: { witcher3: {} },
      loadOrder: { profile: [] },
    },
  };
  const events = new Map<string, (...args: any[]) => unknown>();
  const api = {
    getState: () => state,
    store: { getState: () => state, dispatch: vi.fn<(...args: unknown[]) => void>() },
    events: {
      on: (name: string, handler: (...args: any[]) => unknown) => events.set(name, handler),
    },
    onAsync: vi.fn<(...args: unknown[]) => void>(),
    onStateChange: vi.fn<(...args: unknown[]) => void>(),
    showErrorNotification: vi.fn<(...args: unknown[]) => void>(),
    sendNotification: vi.fn<(...args: unknown[]) => void>(),
    dismissNotification: vi.fn<(...args: unknown[]) => void>(),
    translate: (message: string) => message,
  };
  let game: any;
  let loadOrder: types.ILoadOrderGameInfo;
  const targets = new Map<string, (game: unknown) => string>();
  const checks = new Map<string, types.IHealthCheck>();
  const actions = new Map<string, (...args: any[]) => unknown>();
  const context = {
    api,
    registerGame: (value: unknown) => {
      game = value;
    },
    registerModType: (
      id: string,
      _priority: number,
      _support: unknown,
      resolveTarget: (game: unknown) => string,
    ) => targets.set(id, resolveTarget),
    registerLoadOrder: (value: types.ILoadOrderGameInfo) => {
      loadOrder = value;
    },
    registerHealthCheck: (check: types.IHealthCheck) => checks.set(check.id, check),
    registerAction: (
      _group: string,
      _priority: number,
      _icon: string,
      _options: unknown,
      name: string,
      run: (...args: any[]) => unknown,
    ) => actions.set(name, run),
    registerReducer: vi.fn<(...args: unknown[]) => void>(),
    registerInstaller: vi.fn<(...args: unknown[]) => void>(),
    registerSettings: vi.fn<(...args: unknown[]) => void>(),
    registerMerge: vi.fn<(...args: unknown[]) => void>(),
    registerMigration: vi.fn<(...args: unknown[]) => void>(),
    registerProfileFeature: vi.fn<(...args: unknown[]) => void>(),
    optional: { registerCollectionFeature: vi.fn<(...args: unknown[]) => void>() },
    once: (run: () => void) => run(),
  };
  const module: any = await import("./index");
  const main = module.default.default ?? module.default;
  main(context as unknown as types.IExtensionContext);
  return {
    root,
    host,
    target,
    prefix,
    discovery,
    state,
    api,
    game,
    targets,
    actions,
    checks,
    events,
    loadOrder: loadOrder!,
  };
}

describe("Witcher registered paths", () => {
  it.each([true, false])(
    "setup and document-mod deployment agree with Proton=%s",
    async (proton) => {
      const context = await fixture(proton);
      const bait = path.join(context.host, "host-marker");
      await put(bait, "host document bait");
      if (proton)
        context.state.settings.gameMode.discovered.witcher3 = { path: context.discovery.path };
      await context.game.setup(context.discovery);
      expect((await stat(context.target)).isDirectory()).toBe(true);
      context.state.settings.gameMode.discovered.witcher3 = context.discovery;
      const destination = context.targets.get("witcher3menumoddocuments")!(context.game);
      const source = path.join(context.root, "payload");
      await put(source, "selected menu settings");
      await copyFile(source, path.join(destination, "input.settings"));
      expect(await readFile(path.join(context.target, "input.settings"), "utf8")).toBe(
        "selected menu settings",
      );
      expect(await readFile(bait, "utf8")).toBe("host document bait");
      expect(await exists(path.join(context.host, "input.settings"))).toBe(!proton);
    },
  );

  it.each([true, false])(
    "reads and rewrites actual mods.settings through load-order registration with Proton=%s",
    async (proton) => {
      const context = await fixture(proton);
      const hostSettings = path.join(context.host, "mods.settings");
      const settings = path.join(context.target, "mods.settings");
      const protectedSettings = proton
        ? hostSettings
        : path.join(context.root, "unselected-documents", "mods.settings");
      const bait = "[hostBait]\nEnabled=1\nPriority=91\n";
      await put(hostSettings, bait);
      await put(protectedSettings, bait);
      await put(settings, "[modSelected]\nEnabled=1\nPriority=17\n");
      await put(
        path.join(context.discovery.path, "Mods", "modSelected", "content", "main.ws"),
        "script payload",
      );
      const read = await context.loadOrder.deserializeLoadOrder();
      expect(read.map((entry) => entry.id)).toEqual(["modSelected"]);
      await context.loadOrder.serializeLoadOrder(
        [{ id: "modSelected", name: "Selected", enabled: false }],
        [],
      );
      expect(await readFile(settings, "utf8")).toContain("Enabled=0");
      expect(await readFile(protectedSettings, "utf8")).toBe(bait);
      if (!proton) return;
      await rm(hostSettings);
      const second = path.join(context.root, "second-pfx");
      context.state.settings.gameMode.discovered.witcher3 = {
        path: context.discovery.path,
        protonPrefix: second,
      };
      const secondDocuments = path.join(
        second,
        "drive_c",
        "users",
        "steamuser",
        "Documents",
        "The Witcher 3",
      );
      await put(
        path.join(secondDocuments, "mods.settings"),
        "[modSecond]\nEnabled=1\nPriority=31\n",
      );
      expect((await context.loadOrder.deserializeLoadOrder()).map((entry) => entry.id)).toEqual([
        "modSecond",
      ]);
      expect(context.targets.get("witcher3menumoddocuments")!(context.game)).toBe(secondDocuments);
      context.state.settings.gameMode.discovered.witcher3 = { path: context.discovery.path };
      expect(context.targets.get("witcher3menumoddocuments")!(context.game)).toBe(context.host);
    },
  );

  it("deploys document-mod bytes using the registered target independently of setup", async () => {
    const context = await fixture();
    const destination = context.targets.get("witcher3menumoddocuments")!(context.game);
    const source = path.join(context.root, "payload");
    await put(source, "proton menu payload 73");
    await mkdir(destination, { recursive: true });
    await copyFile(source, path.join(destination, "input.settings"));
    expect(await readFile(path.join(context.target, "input.settings"), "utf8")).toBe(
      "proton menu payload 73",
    );
    await expect(stat(path.join(context.host, "input.settings"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the stored order when Proton mods.settings is absent despite host bait", async () => {
    const context = await fixture();
    await put(path.join(context.host, "mods.settings"), "[hostBait]\nEnabled=1\nPriority=91\n");
    const saved = [{ id: "modStored", enabled: true }];
    context.state.persistent.loadOrder.profile = saved as any;
    expect(await context.loadOrder.deserializeLoadOrder()).toEqual(saved);
    await expect(stat(path.join(context.target, "mods.settings"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("checks and fixes Proton game switches and their backup without changing host bait", async () => {
    const context = await fixture();
    await put(
      path.join(context.discovery.path, "bin", "x64_dx12", "witcher3.exe"),
      "edition marker",
    );
    const enabled = "[ContentManager/Mods]\nEnabled=true\nEnabledLocal=true\n[Other]\nKeep=73\n";
    const disabled = enabled.replace("EnabledLocal=true", "EnabledLocal=false");
    const hostSettings = path.join(context.host, "dx12user.settings");
    const settings = path.join(context.target, "dx12user.settings");
    await put(hostSettings, enabled);
    await put(settings, disabled);
    await put(settings + ".vortex_backup", disabled);
    const check = context.checks.get("witcher3-local-mods-enabled")!;
    const api = context.api as unknown as types.IExtensionApi;
    expect((await check.check(api)).status).toBe("failed");
    await check.fix!(api);
    expect((await check.check(api)).status).toBe("passed");
    expect(await readFile(settings, "utf8")).toContain("EnabledLocal=true");
    expect(await readFile(settings + ".vortex_backup", "utf8")).toContain("EnabledLocal=true");
    expect(await readFile(settings, "utf8")).toContain("Keep=73");
    expect(await readFile(hostSettings, "utf8")).toBe(enabled);
  });

  it("stores the Proton load order through the registered profile-change callback", async () => {
    const context = await fixture();
    const merger = path.join(context.root, "merger");
    Object.assign(context.discovery, {
      tools: { W3ScriptMerger: { path: path.join(merger, "WitcherScriptMerger.exe") } },
    });
    await put(path.join(context.host, "mods.settings"), "host backup bait");
    await put(path.join(context.target, "mods.settings"), "proton profile order 73");
    Object.assign(context.state.persistent.profiles.incoming.features, { local_merges: true });
    await put(path.join(merger, "incoming", "mods.settings"), "restored proton order 91");
    await context.events.get("profile-will-change")!("incoming");
    expect(context.api.showErrorNotification).not.toHaveBeenCalled();
    expect(await readFile(path.join(merger, "profile", "mods.settings"), "utf8")).toBe(
      "proton profile order 73",
    );
    expect(await readFile(path.join(context.host, "mods.settings"), "utf8")).toBe(
      "host backup bait",
    );
    expect(await readFile(path.join(context.target, "mods.settings"), "utf8")).toBe(
      "restored proton order 91",
    );
  });

  it("opens the current discovered game's documents folder from its registered action", async () => {
    const context = await fixture();
    const { util } = await import("@nexusmods/vortex-api");
    context.actions.get("Open TW3 Documents Folder")!();
    expect(util.opn).toHaveBeenCalledWith(context.target);
  });
});
