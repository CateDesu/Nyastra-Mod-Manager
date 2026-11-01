import { readdirSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { types } from "@nexusmods/vortex-api";
import Bluebird from "bluebird";
import { types as actionTypes } from "redux-act";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_MOD_SETTINGS_V8, GAME_ID, MOD_TYPE_SECONFIG } from "./common";

const runtime = vi.hoisted(() => ({
  paths: {} as Record<string, string>,
  version: "4.1.1.0",
  reads: [] as string[],
  pending: new Set<Promise<unknown>>(),
}));

function track<T>(work: Promise<T>): Bluebird<T> {
  runtime.pending.add(work);
  void work.then(
    () => runtime.pending.delete(work),
    () => runtime.pending.delete(work),
  );
  return Bluebird.resolve(work);
}

vi.mock("@nexusmods/vortex-api", () => ({
  fs: {
    statAsync: (file: string) => track(stat(file)),
    readdirSync,
    readdirAsync: (file: string) => track(readdir(file)),
    readFileAsync: (file: string, options: any) => {
      runtime.reads.push(file);
      return track(readFile(file, options));
    },
    writeFileAsync: (file: string, data: string, options: any) =>
      track(writeFile(file, data, options)),
    ensureDirAsync: (file: string) => track(mkdir(file, { recursive: true })),
    ensureDirWritableAsync: (file: string) => track(mkdir(file, { recursive: true })),
    copyAsync: (source: string, destination: string) => track(copyFile(source, destination)),
    removeAsync: (file: string) => track(rm(file, { recursive: true, force: true })),
  },
  selectors: {
    discoveryByGame: (state: any, id: string) => state.settings.gameMode.discovered[id],
    activeGameId: () => GAME_ID,
    activeProfile: (state: any) => state.persistent.profiles.profile,
    profileById: (state: any, id: string) => state.persistent.profiles[id],
    lastActiveProfileForGame: () => "profile",
    installPathForGame: (state: any) => state.staging,
  },
  actions: {},
  util: {
    getVortexPath: (name: string) => {
      if (!runtime.paths[name]) throw new Error(`Unexpected host path: ${name}`);
      return runtime.paths[name];
    },
    getGame: () => ({ getInstalledVersion: async () => runtime.version }),
    getSafe: (value: any, keys: string[], fallback: unknown) =>
      keys.reduce((entry, key) => entry?.[key], value) ?? fallback,
    Debouncer: class {
      schedule = vi.fn<(...args: unknown[]) => void>();
    },
    withErrorContext: (_operation: string, _file: string, run: () => unknown) => run(),
    getManifest: async () => ({ files: [] }),
    opn: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  },
  log: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock("exe-version", () => ({
  getFileVersion: async () => "4.67.58.10",
  getProductVersionLocalized: async () => runtime.version,
}));

vi.mock("./githubDownloader", () => ({
  downloadDivine: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));

vi.mock("./divineWrapper", () => ({
  abortDivineOperations: vi.fn<(...args: unknown[]) => void>(),
  listPackage: vi.fn<(...args: unknown[]) => Promise<string[]>>(async () => [
    "Mods/Selected/meta.lsx\t100\t0",
  ]),
  extractPak: async (_api: unknown, _source: string, destination: string) => {
    await writeFile(
      path.join(destination, "meta.lsx"),
      '<save><region id="Config"><node id="root"><children><node id="ModuleInfo">' +
        '<attribute id="Name" value="Selected metadata"/>' +
        '<attribute id="UUID" value="selected-uuid"/>' +
        "</node></children></node></region></save>",
    );
  },
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  try {
    while (runtime.pending.size > 0) await Promise.allSettled(runtime.pending);
  } finally {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  }
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

const gameData = (base: string) => path.join(base, "Larian Studios", "Baldur's Gate 3");

async function fixture(proton = true) {
  actionTypes.clear();
  vi.resetModules();
  const root = await mkdtemp(path.join(tmpdir(), "nyastra-bg3-paths-"));
  roots.push(root);
  runtime.paths = {
    localAppData: path.join(root, "host-local"),
    temp: path.join(root, "temp"),
    userData: path.join(root, "user-data"),
  };
  await mkdir(path.join(runtime.paths.userData, GAME_ID), { recursive: true });
  runtime.version = "4.1.1.0";
  runtime.reads = [];
  const prefix = path.join(root, "compatdata", "1086940", "pfx");
  const protonData = path.join(prefix, "drive_c", "users", "steamuser", "AppData", "Local");
  const host = gameData(runtime.paths.localAppData);
  const target = gameData(proton ? protonData : runtime.paths.localAppData);
  const discovery = { path: path.join(root, "game"), ...(proton ? { protonPrefix: prefix } : {}) };
  const state = {
    staging: path.join(root, "staging"),
    settings: {
      gameMode: { discovered: { [GAME_ID]: discovery } },
      baldursgate3: { extensionVersion: "1.5.10", playerProfile: "Selected" },
    },
    persistent: {
      profiles: { profile: { id: "profile", gameId: GAME_ID, modState: {} } },
      mods: { [GAME_ID]: {} as Record<string, unknown> },
      loadOrder: {
        profile: [
          {
            id: "selected.pak",
            enabled: true,
            data: {
              uuid: "selected-uuid",
              name: "Selected export",
              folder: "Selected",
              version: "42",
              md5: "",
            },
          },
        ],
      },
    },
  };
  const changes = new Map<string, (...args: any[]) => unknown>();
  const events = new Map<string, (...args: any[]) => unknown>();
  const api = {
    getState: () => state,
    store: { getState: () => state, dispatch: vi.fn<(...args: unknown[]) => void>() },
    onStateChange: (keys: string[], handler: (...args: any[]) => unknown) =>
      changes.set(keys.join("/"), handler),
    events: {
      on: (name: string, handler: (...args: any[]) => unknown) => events.set(name, handler),
    },
    onAsync: vi.fn<(...args: unknown[]) => void>(),
    sendNotification: vi.fn<(...args: unknown[]) => void>(),
    dismissNotification: vi.fn<(...args: unknown[]) => void>(),
    showErrorNotification: vi.fn<(...args: unknown[]) => void>(),
    translate: (message: string) => message,
  };
  const actions = new Map<string, (...args: any[]) => unknown>();
  const modTypes = new Map<string, (game: unknown) => string>();
  let game: any;
  let loadOrder: types.ILoadOrderGameInfo;
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
    ) => modTypes.set(id, resolveTarget),
    registerLoadOrder: (value: types.ILoadOrderGameInfo) => {
      loadOrder = value;
    },
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
    once: (run: () => void) => run(),
  };
  const main = (await import("./index")).default;
  main(context as unknown as types.IExtensionContext);
  return {
    root,
    prefix,
    host,
    target,
    discovery,
    state,
    api,
    game,
    loadOrder: loadOrder!,
    modTypes,
    actions,
    events,
  };
}

describe("BG3 registered paths", () => {
  it.each([true, false])(
    "deploys PAK and extender config payloads with Proton=%s",
    async (proton) => {
      const context = await fixture(proton);
      const source = path.join(context.root, "payload");
      await put(source, "selected deployment bytes");
      const mods = context.game.queryModPath(context.discovery.path);
      const extender = context.modTypes.get(MOD_TYPE_SECONFIG)!(context.game);
      await mkdir(mods, { recursive: true });
      await mkdir(extender, { recursive: true });
      await copyFile(source, path.join(mods, "selected.pak"));
      await copyFile(source, path.join(extender, "ScriptExtenderSettings.json"));
      expect(await readFile(path.join(context.target, "Mods", "selected.pak"), "utf8")).toBe(
        "selected deployment bytes",
      );
      expect(
        await readFile(
          path.join(context.target, "Script Extender", "ScriptExtenderSettings.json"),
          "utf8",
        ),
      ).toBe("selected deployment bytes");
      expect(await exists(path.join(context.host, "Mods"))).toBe(!proton);
      context.state.settings.gameMode.discovered[GAME_ID] = { path: context.discovery.path };
      expect(context.game.queryModPath(context.discovery.path)).toBe(
        path.join(context.host, "Mods"),
      );
      expect(context.modTypes.get(MOD_TYPE_SECONFIG)!(context.game)).toBe(
        path.join(context.host, "Script Extender"),
      );
    },
  );

  it.each([true, false])(
    "setup creates the profile consumed by load-order export with Proton=%s",
    async (proton) => {
      const context = await fixture(proton);
      const bait = path.join(context.host, "Public", "modsettings.lsx");
      await put(bait, "host sibling bait");
      if (proton)
        context.state.settings.gameMode.discovered[GAME_ID] = { path: context.discovery.path };
      await context.game.setup(context.discovery);
      expect(
        await readFile(
          path.join(context.target, "PlayerProfiles", "Public", "modsettings.lsx"),
          "utf8",
        ),
      ).toContain('value="GustavX"');
      expect((await stat(path.join(context.target, "Mods"))).isDirectory()).toBe(true);
      expect(await readFile(bait, "utf8")).toBe("host sibling bait");
      expect(await exists(path.join(context.host, "Mods"))).toBe(!proton);
    },
  );

  it.each([true, false])(
    "exports through the registered action to the current discovery with Proton=%s",
    async (proton) => {
      const context = await fixture(proton);
      if (proton) {
        const prefix = path.join(context.root, "new-discovery-pfx");
        context.state.settings.gameMode.discovered[GAME_ID] = {
          path: context.discovery.path,
          protonPrefix: prefix,
        };
        context.target = path.join(
          prefix,
          "drive_c",
          "users",
          "steamuser",
          "AppData",
          "Local",
          "Larian Studios",
          "Baldur's Gate 3",
        );
      }
      const settings = path.join(context.target, "PlayerProfiles", "Public", "modsettings.lsx");
      const hostSettings = path.join(context.host, "PlayerProfiles", "Public", "modsettings.lsx");
      const protectedSettings = proton
        ? hostSettings
        : path.join(context.host, "PlayerProfiles", "Unselected", "modsettings.lsx");
      const bait = DEFAULT_MOD_SETTINGS_V8.replaceAll("GustavX", "GustavHostBait");
      await put(hostSettings, bait);
      await put(protectedSettings, bait);
      if (proton) await put(settings, DEFAULT_MOD_SETTINGS_V8);
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      context.api.sendNotification.mockImplementation(complete);
      context.api.showErrorNotification.mockImplementation(complete);
      context.actions.get("Export to Game")!();
      await completed;
      expect(context.api.showErrorNotification).not.toHaveBeenCalled();
      expect(await readFile(settings, "utf8")).toContain('value="Selected export"');
      expect(await readFile(protectedSettings, "utf8")).toBe(bait);
    },
  );

  it("reports missing Proton settings and retries without exporting over valid host bait", async () => {
    const context = await fixture();
    const hostSettings = path.join(context.host, "PlayerProfiles", "Public", "modsettings.lsx");
    const settings = path.join(context.target, "PlayerProfiles", "Public", "modsettings.lsx");
    await put(hostSettings, DEFAULT_MOD_SETTINGS_V8);
    const exportRegistered = async () => {
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      context.api.sendNotification.mockImplementation(complete);
      context.api.showErrorNotification.mockImplementation(complete);
      context.actions.get("Export to Game")!();
      await completed;
    };
    await exportRegistered();
    expect(context.api.showErrorNotification).toHaveBeenCalledWith(
      "Failed to write load order",
      expect.objectContaining({ code: "ENOENT" }),
      expect.anything(),
    );
    expect(await readFile(hostSettings, "utf8")).toBe(DEFAULT_MOD_SETTINGS_V8);
    await put(settings, DEFAULT_MOD_SETTINGS_V8);
    context.api.showErrorNotification.mockClear();
    await exportRegistered();
    expect(context.api.showErrorNotification).not.toHaveBeenCalled();
    expect(await readFile(settings, "utf8")).toContain('value="Selected export"');
    expect(await readFile(hostSettings, "utf8")).toBe(DEFAULT_MOD_SETTINGS_V8);
  });

  it("reads deployed PAKs through the registered load-order callback", async () => {
    const context = await fixture();
    await put(path.join(context.target, "Mods", "selected.pak"), "proton pak bytes");
    await put(path.join(context.host, "Mods", "host-bait.pak"), "host pak bait");
    await put(
      path.join(context.state.staging, "lslib", "tools", "divine.exe"),
      "external tool fixture",
    );
    context.state.persistent.mods[GAME_ID].lslib = {
      id: "lslib",
      type: "bg3-lslib-divine-tool",
      installationPath: "lslib",
      attributes: { version: "1.19.0" },
    };
    const order = await context.loadOrder.deserializeLoadOrder();
    expect(order.map((entry) => entry.id)).toEqual(["selected.pak"]);
    const { listPackage } = await import("./divineWrapper");
    expect(listPackage).toHaveBeenCalledWith(
      context.api,
      path.join(context.target, "Mods", "selected.pak"),
    );
    expect(await readFile(path.join(context.host, "Mods", "host-bait.pak"), "utf8")).toBe(
      "host pak bait",
    );
  });

  it("activation reads a player profile created after extension registration", async () => {
    const context = await fixture(false);
    runtime.version = "4.0.0";
    const settings = path.join(context.target, "PlayerProfiles", "Selected", "modsettings.lsx");
    await put(settings, DEFAULT_MOD_SETTINGS_V8);
    await put(settings + ".backup", "existing backup");
    await context.events.get("gamemode-activated")!(GAME_ID);
    expect(context.api.showErrorNotification).not.toHaveBeenCalled();
    expect(runtime.reads).toContain(settings);
    expect(runtime.reads).not.toContain(
      path.join(context.target, "PlayerProfiles", "Public", "modsettings.lsx"),
    );
  });
});
