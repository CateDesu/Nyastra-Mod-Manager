import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createRequire, Module } from "node:module";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import { afterEach, expect, test, vi } from "vitest";
import IniParser, { IniFile, WinapiFormat } from "vortex-parse-ini";

import * as errors from "../../util/CustomErrors";
import deepMerge from "../../util/deepMerge";
import * as selectors from "../../util/selectors";
import * as storeHelper from "../../util/storeHelper";
import { makeOverlayableDictionary, objDiff, setdefault } from "../../util/util";

const repo = path.resolve(__dirname, "../../../../..");
const require = createRequire(path.join(repo, "src/renderer/package.json"));
const ts = createRequire(path.join(repo, "package.json"))("typescript");
const roots: string[] = [];
type GameIni = { General: Record<string, string> };

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function productionLoader(overrides: Record<string, unknown>) {
  const modules = new Map<string, Module>();
  const load = (filename: string): any => {
    if (modules.has(filename)) return modules.get(filename)!.exports;
    const loaded = new Module(filename);
    modules.set(filename, loaded);
    loaded.filename = filename;
    loaded.paths = require.resolve.paths("bluebird")!;
    loaded.require = (id) => {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id.startsWith(".")) return load(path.resolve(path.dirname(filename), id + ".ts"));
      return require(id);
    };
    (loaded as any)._compile(
      ts.transpileModule(require("node:fs").readFileSync(filename, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText,
      filename,
    );
    return loaded.exports;
  };
  return (relative: string) => load(path.join(repo, relative));
}

function savesFixture(
  root: string,
  documents: string,
  profile: {
    id: string;
    gameId: string;
    features: { local_game_settings: boolean; local_saves: boolean };
    modState: object;
  },
  discovery: { path: string; store: string; protonPrefix?: string },
) {
  const state = {
    persistent: { profiles: { [profile.id]: profile } },
    settings: {
      profiles: { activeProfileId: profile.id },
      gameMode: { discovered: { [profile.gameId]: discovery } },
      mods: { installPath: { [profile.gameId]: path.join(root, "staging") } },
    },
  };
  const events = new EventEmitter();
  const dispatch = vi.fn();
  const schedule = vi.fn();
  const showErrorNotification = vi.fn();
  const api = {
    store: { getState: () => state, dispatch },
    events,
    onAsync: (event: string, listener: (...args: any[]) => unknown) => events.on(event, listener),
    onStateChange: vi.fn(),
    setStylesheet: vi.fn(),
    translate: (key: string) => key,
    showErrorNotification,
    emitAndAwait: (event: string, ...args: any[]) =>
      Bluebird.map(events.listeners(event), (listener) => listener(...args)),
  };
  const callbacks: Array<() => void> = [];
  const context = new Proxy(
    { api, once: (callback: () => void) => callbacks.push(callback) },
    { get: (target, key) => (key in target ? target[key] : () => undefined) },
  );
  const native = Bluebird.promisifyAll(require("fs-extra"));
  const nativeApi = {
    ...native,
    forcePerm: (_translate, operation) => operation(),
    makeFileWritableAsync: (file: string) => Bluebird.resolve(fs.chmod(file, 0o600)),
  };
  const getVortexPath = (key: string) =>
    key === "documents" ? documents : path.join(root, "data");
  const load = productionLoader({
    "@nexusmods/vortex-api": {
      selectors,
      fs: nativeApi,
      actions: {},
      log: vi.fn(),
      util: {
        ...storeHelper,
        makeOverlayableDictionary,
        getVortexPath,
        Debouncer: class {
          schedule = schedule;
        },
      },
    },
    "vortex-parse-ini": { __esModule: true, default: IniParser, IniFile, WinapiFormat },
    "../../logging": { log: vi.fn() },
    "../../util/CustomErrors": errors,
    "../../util/deepMerge": { __esModule: true, default: deepMerge },
    "../../util/errorHandling": { disableErrorReport: vi.fn() },
    "../../util/fs": nativeApi,
    "../../util/getVortexPath": { __esModule: true, default: getVortexPath },
    "../../util/selectors": selectors,
    "../../util/storeHelper": storeHelper,
    "../../util/util": { objDiff, setdefault, makeOverlayableDictionary },
    "../../util/linux/proton": {
      getMyGamesPath: () => {
        throw new Error("unexpected Steam prefix lookup");
      },
    },
    "../../util/Steam": { __esModule: true, default: { snapshot: () => ({ entries: [] }) } },
    "../mod_management/InstallManager": { INI_TWEAKS_PATH: "INI Tweaks" },
    "../nexus_integration/constants": { NEXUS_DOMAIN: "example.invalid" },
    "../profile_management/selectors": selectors,
    "./TweakList": { default: () => null },
    "./views/SavegameList": { default: () => null },
    "./util/refreshSavegames": {},
    "./util/restoreSavegamePlugins": { default: () => undefined },
  });
  const start = (withSaves = true) => {
    events.removeAllListeners();
    callbacks.length = 0;
    load("src/renderer/src/extensions/ini_prep/index.ts").default(context);
    if (withSaves) load("extensions/gamebryo-savegame-management/src/index.ts").default(context);
    callbacks.forEach((callback) => callback());
    schedule.mockClear();
    dispatch.mockClear();
  };
  vi.spyOn(window, "addEventListener").mockImplementation(() => {});
  return { api, events, load, start, dispatch, schedule, showErrorNotification };
}

const installs = [
  { gameId: "enderalspecialedition", install: "skyrim/Enderal", store: "steam", overlay: true },
  { gameId: "enderalspecialedition", install: "Skyrim/Enderal", store: "steam", overlay: true },
  { gameId: "enderalspecialedition", install: "SKYRIM/Enderal", store: "gog", overlay: true },
  { gameId: "enderalspecialedition", install: "Enderal", store: "steam", overlay: false },
  { gameId: "enderalspecialedition", install: "Enderal", store: "gog", overlay: false },
  { gameId: "enderal", install: "EnderalClassic", store: "steam", overlay: false },
  { gameId: "skyrimse", install: "Skyrim", store: "steam", overlay: false },
];

for (const install of installs) {
  for (const proton of [false, true]) {
    test.each(
      [true, false].flatMap((saves) =>
        ["none", "lowercase", "mixed", "named"].map((tweak) => [saves, tweak] as const),
      ),
    )(
      `${install.gameId} at ${install.install} via ${install.store}, Proton=${proton}, private saves=%s, tweak=%s`,
      async (localSaves, tweakCase) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "nyastra-private-saves-"));
        roots.push(root);
        const documents = path.join(root, "documents");
        const prefix = path.join(root, "compatdata", "pfx");
        const discovery = {
          path: path.join(root, "games", install.install),
          store: install.store,
          ...(proton ? { protonPrefix: prefix } : {}),
        };
        const profile = {
          id: "private-profile",
          gameId: install.gameId,
          features: { local_game_settings: true, local_saves: localSaves },
          modState: {},
        };
        const { api, events, load, start, schedule, dispatch, showErrorNotification } =
          savesFixture(root, documents, profile, discovery);
        const renderer = load("src/renderer/src/extensions/ini_prep/gameSupport.ts");
        const privateSettings = load("extensions/local-gamesettings/src/util/gameSupport.ts");
        const saves = load("extensions/gamebryo-savegame-management/src/util/gameSupport.ts");
        privateSettings.initGameSupport(api);
        start();
        expect(events.listenerCount("apply-settings")).toBe(1);

        const mygames = proton
          ? path.join(prefix, "drive_c", "users", "steamuser", "Documents", "My Games")
          : path.join(documents, "My Games");
        const folder =
          install.overlay || profile.gameId === "skyrimse"
            ? "Skyrim Special Edition"
            : profile.gameId === "enderal"
              ? "Enderal"
              : install.store === "gog"
                ? "Enderal Special Edition GOG"
                : "Enderal Special Edition";
        const iniName = install.overlay || profile.gameId === "skyrimse" ? "Skyrim" : "Enderal";
        const directory = path.join(mygames, folder);
        const main = path.join(directory, iniName + ".ini");
        const prefs = path.join(directory, iniName + "Prefs.ini");
        await fs.mkdir(directory, { recursive: true });
        for (const file of [main, prefs]) {
          for (const suffix of ["", ".base", ".baked"])
            await fs.writeFile(file + suffix, "[General]\nowner=private\n");
        }
        const withTweak = tweakCase !== "none";
        const tweakName =
          tweakCase === "named"
            ? `Quality[${iniName}].ini`
            : tweakCase === "lowercase"
              ? path.basename(main).toLowerCase()
              : path.basename(main);
        const mods = withTweak
          ? [{ installationPath: "tweak-mod", enabledINITweaks: [tweakName] }]
          : [];
        if (withTweak) {
          const tweaks = path.join(root, "staging", "tweak-mod", "INI Tweaks");
          await fs.mkdir(tweaks, { recursive: true });
          await fs.writeFile(path.join(tweaks, tweakName), "[General]\nmodTweak=applied\n");
        }
        const unused = path.join(directory, iniName === "Skyrim" ? "Enderal.ini" : "Skyrim.ini");
        await fs.writeFile(unused, "untouched INI");
        const parser = new IniParser(new WinapiFormat());
        const expectedSavePath =
          (profile.gameId === "skyrimse"
            ? "Saves/"
            : profile.gameId === "enderal"
              ? "../Enderal/Saves/"
              : "../Enderal Special Edition/Saves/") + (localSaves ? "private-profile/" : "");

        expect(
          await api.emitAndAwait("bake-settings", profile.gameId, mods, profile, {
            reportResult: true,
          }),
        ).toEqual([{ settingsBaked: true }]);
        for (const file of [main, main + ".baked"]) {
          const { data } = await parser.read<GameIni>(file);
          expect(data.General.SLocalSavePath).toBe(expectedSavePath);
          expect(data.General.owner).toBe("private");
          expect(data.General.modTweak).toBe(withTweak ? "applied" : undefined);
        }
        expect(path.resolve(directory, expectedSavePath)).toBe(
          path.join(
            mygames,
            profile.gameId === "enderalspecialedition" ? "Enderal Special Edition" : folder,
            "Saves",
            ...(localSaves ? [profile.id] : []),
          ),
        );
        expect((await parser.read<GameIni>(prefs)).data.General.SLocalSavePath).toBeUndefined();
        expect(
          (await parser.read<GameIni>(main + ".base")).data.General.SLocalSavePath,
        ).toBeUndefined();
        expect(await fs.readFile(unused, "utf8")).toBe("untouched INI");
        expect(renderer.iniFiles(profile.gameId, discovery)).toContain(main);
        expect(privateSettings.mygamesPath(profile.gameId)).toBe(directory);
        expect(privateSettings.gameSettingsFiles(profile.gameId, null)).toContainEqual({
          name: path.basename(main),
          optional: false,
        });
        expect(saves.iniPath(profile.gameId)).toBe(main);
        expect(saves.prefIniPath(profile.gameId)).toBe(prefs);
        expect(schedule).toHaveBeenCalledWith(
          undefined,
          profile.id,
          path.join(directory, expectedSavePath),
        );
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ payload: expectedSavePath }),
        );
        expect(showErrorNotification).not.toHaveBeenCalled();
      },
    );
  }
}

test.each(["absent", "present", "tweak", "disabled", "no-hook", "io-error"])(
  "Fallout 4 private saves with Custom INI %s",
  async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nyastra-fallout-saves-"));
    roots.push(root);
    const documents = path.join(root, "documents");
    const directory = path.join(documents, "My Games", "Fallout4");
    const custom = path.join(directory, "Fallout4Custom.ini");
    const profile = {
      id: "private-profile",
      gameId: "fallout4",
      features: { local_game_settings: true, local_saves: mode !== "disabled" },
      modState: {},
    };
    const discovery = { path: path.join(root, "game"), store: "steam" };
    const staging = path.join(root, "staging");
    const { api, start } = savesFixture(root, documents, profile, discovery);
    start(mode !== "no-hook");
    await fs.mkdir(directory, { recursive: true });
    for (const file of [
      "Fallout4.ini",
      "Fallout4Prefs.ini",
      ...(mode === "present" ? ["Fallout4Custom.ini"] : []),
    ])
      for (const suffix of ["", ".base", ".baked"])
        await fs.writeFile(path.join(directory, file + suffix), "[General]\nowner=private\n");
    const mods = mode === "tweak" ? [{ installationPath: "mod" }] : [];
    if (mode === "tweak") {
      const tweaks = path.join(staging, "mod", "INI Tweaks");
      await fs.mkdir(tweaks, { recursive: true });
      await fs.writeFile(path.join(tweaks, "Fallout4Custom.ini"), "[General]\ntweak=yes\n");
    }
    if (mode === "io-error") await fs.mkdir(custom);
    const bake = () =>
      api.emitAndAwait("bake-settings", profile.gameId, mods, profile, { reportResult: true });
    const result = await bake();

    if (mode === "io-error") {
      expect(result).toMatchObject([{ settingsBaked: false, error: { code: "EISDIR" } }]);
      expect((await fs.stat(custom)).isDirectory()).toBe(true);
      return;
    }
    expect(result).toEqual([{ settingsBaked: true }]);
    if (mode === "no-hook") {
      await expect(fs.stat(custom)).rejects.toMatchObject({ code: "ENOENT" });
      start(false);
      expect(
        await api.emitAndAwait("bake-settings", profile.gameId, mods, profile, {
          reportResult: true,
        }),
      ).toEqual([{ settingsBaked: true }]);
      await expect(fs.stat(custom)).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }
    expect(await fs.readFile(custom, "utf8")).toContain(
      mode === "disabled" ? "SLocalSavePath=Saves/" : "SLocalSavePath=Saves/private-profile/",
    );
    if (mode === "tweak") expect(await fs.readFile(custom, "utf8")).toContain("tweak=yes");
    start();
    // Deployments can overlap when the local settings extension is disabled.
    expect(await Promise.all([bake(), bake()])).toEqual([
      [{ settingsBaked: true }],
      [{ settingsBaked: true }],
    ]);
    expect(await fs.readFile(custom, "utf8")).toContain(
      mode === "disabled" ? "SLocalSavePath=Saves/" : "SLocalSavePath=Saves/private-profile/",
    );
    profile.features.local_saves = false;
    expect(
      await api.emitAndAwait("bake-settings", profile.gameId, [], profile, { reportResult: true }),
    ).toEqual([{ settingsBaked: true }]);
    const global = await fs.readFile(custom, "utf8");
    expect(global).toContain("SLocalSavePath=Saves/");
    expect(global).not.toContain("Saves/private-profile/");
  },
);
