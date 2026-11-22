import fs from "node:fs/promises";
import { createRequire, Module } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as waitForIO } from "node:timers/promises";

import { unknownToError } from "@vortex/shared";
import { DataInvalid, VortexError } from "@vortex/shared/errors";
import * as sharedState from "@vortex/shared/state";
import Bluebird from "bluebird";
import { afterEach, beforeEach, expect, test as vitest, vi } from "vitest";
import IniParser, { IniFile, WinapiFormat } from "vortex-parse-ini";

import {
  makeApiHarness,
  makeProfile,
  registerHarnessGame,
  resetHarnessRegistries,
} from "../../test-utils/builders";
import * as errors from "../../util/CustomErrors";
import deepMerge from "../../util/deepMerge";
import { copyAsync as copyProgramFile } from "../../util/fs";
import * as selectors from "../../util/selectors";
import { getSafe } from "../../util/storeHelper";
import { makeOverlayableDictionary, objDiff, setdefault } from "../../util/util";
import { setFeature, setProfile } from "../profile_management/actions/profiles";
import { setNextProfile } from "../profile_management/actions/settings";
import initProfiles from "../profile_management/index";
import { profilesReducer } from "../profile_management/reducers/profiles";
import { settingsReducer } from "../profile_management/reducers/settings";

const repo = path.resolve(__dirname, "../../../../..");
const require = createRequire(path.join(repo, "src/renderer/package.json"));
const ts = createRequire(path.join(repo, "package.json"))("typescript");

const unfinishedTests = new Set<Promise<unknown>>();

async function settleTestWork(work: Iterable<Promise<unknown>>) {
  const deadline = new AbortController();
  try {
    await Promise.race([
      Promise.allSettled(work),
      waitForIO(1000, undefined, { signal: deadline.signal }).then(() => {
        throw new Error("Earlier recovery test work has not settled");
      }),
    ]);
  } finally {
    deadline.abort();
  }
}

// Vitest's timeout does not stop an async callback or its finally block.
function joinedTest(register: typeof vitest): typeof vitest {
  return new Proxy(register, {
    apply(target, receiver, [name, callback, ...options]) {
      return Reflect.apply(target, receiver, [
        name,
        (...args) => {
          const work = Promise.resolve().then(() => callback(...args));
          unfinishedTests.add(work);
          void work.then(
            () => unfinishedTests.delete(work),
            () => unfinishedTests.delete(work),
          );
          return work;
        },
        ...options,
      ]);
    },
    get(target, property, receiver) {
      if (property === "each")
        return (...args) => joinedTest(Reflect.apply(target.each, target, args));
      return Reflect.get(target, property, receiver);
    },
  });
}

const test = joinedTest(vitest);
beforeEach(() => {
  if (unfinishedTests.size > 0) throw new Error("Earlier recovery test work has not settled");
});
afterEach(() => settleTestWork(unfinishedTests));

function productionFunctions(relative: string, names: string[], bindings: Record<string, unknown>) {
  const filename = path.join(repo, relative);
  const source = ts.createSourceFile(
    filename,
    require("node:fs").readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
  );
  const functions = source.statements.filter(
    (node) =>
      (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((item) => names.includes(item.name?.text))),
  );
  expect(functions).toHaveLength(names.length);
  const code = ts.transpile(functions.map((node) => node.getText(source)).join("\n"), {
    target: ts.ScriptTarget.ES2022,
  });
  // Load the production functions with the test harness bindings.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return Function(
    ...Object.keys(bindings),
    code + `\nreturn { ${names.join(", ")} };`,
  )(...Object.values(bindings));
}

async function recoveryFixture(
  wasPrivate: boolean,
  tweakName = "test[skyrim].ini",
  saves = false,
  blockBootstrap = false,
  gameId = "skyrimse",
  enderal?: { privateSettings: boolean; installation: string; separate?: boolean },
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nyastra-settings-recovery-"));
  const documents = path.join(root, "documents");
  let data = path.join(root, "data");
  const game = path.join(
    documents,
    "My Games",
    gameId === "starfield" ? "Starfield" : "Skyrim Special Edition",
  );
  let backup = path.join(data, gameId);
  let saved = path.join(backup, "profiles", "p");
  const files =
    gameId === "starfield"
      ? ["StarfieldCustom.ini", "StarfieldPrefs.ini"]
      : ["Skyrim.ini", "SkyrimPrefs.ini", "SkyrimCustom.ini"];
  const content = (owner: string) => `[General]\nowner=${owner}\ntweak=0\n`;
  await Promise.all([game, saved].map((dir) => fs.mkdir(dir, { recursive: true })));
  for (const file of files) {
    for (const suffix of ["", ".base", ".baked"])
      await fs.writeFile(path.join(game, file + suffix), content(wasPrivate ? "latest" : "global"));
    await fs.writeFile(path.join(saved, file), content("private"));
    await fs.writeFile(path.join(backup, file), content("global"));
  }
  const enderalId = "enderalspecialedition";
  const enderalPrefix = enderal?.separate ? path.join(root, "enderal-prefix") : undefined;
  const enderalGame = enderalPrefix
    ? path.join(enderalPrefix, "drive_c/users/steamuser/Documents/My Games/Skyrim Special Edition")
    : game;
  const enderalBackup = path.join(data, enderalId);
  const enderalSaved = path.join(enderalBackup, "profiles", "e");
  if (enderal) {
    registerHarnessGame(enderalId);
    await fs.mkdir(enderalSaved, { recursive: true });
    await fs.mkdir(enderalGame, { recursive: true });
    for (const file of files) {
      await fs.writeFile(path.join(enderalSaved, file), content("enderal-private"));
      await fs.writeFile(path.join(enderalBackup, file), content("enderal-global"));
      if (enderal.separate)
        for (const suffix of ["", ".base", ".baked"])
          await fs.writeFile(
            path.join(enderalGame, file + suffix),
            content(enderal.privateSettings ? "enderal-latest" : "enderal-global"),
          );
    }
  }
  const mods = path.join(root, "mods");
  const tweaks = path.join(mods, "tweak", "INI Tweaks");
  await fs.mkdir(tweaks, { recursive: true });
  await fs.writeFile(path.join(tweaks, tweakName), "[General]\ntweak=1\n");
  registerHarnessGame(gameId);
  registerHarnessGame("other");
  const native = Bluebird.promisifyAll(require("fs-extra"));
  let block = false;
  let blockedFile: string;
  let checkpointBlock = false;
  let seedFailure = false;
  let recoveryFile = path.join(data, "local-game-settings.json");
  if (blockBootstrap) await fs.mkdir(recoveryFile + ".tmp");
  let copyOverride: (
    source: string,
    destination: string,
    copy: () => PromiseLike<void>,
  ) => PromiseLike<void>;
  const nativeApi = {
    ...native,
    copyAsync: (source: string, destination: string, options: unknown) =>
      Bluebird.try(async () => {
        if (seedFailure && destination.endsWith(".settings.tmp")) {
          seedFailure = false;
          await fs.writeFile(destination, "partial seed");
          throw Object.assign(new Error("seed write interrupted"), { code: "ENOSPC" });
        }
        if (
          block &&
          destination === blockedFile &&
          source === path.join(wasPrivate ? backup : saved, "SkyrimPrefs.ini")
        ) {
          block = false;
          await fs.rename(destination, destination + ".held");
          await fs.mkdir(destination);
        }
        const copy = () => native.copy(source, destination, options);
        await (copyOverride ? copyOverride(source, destination, copy) : copy());
        if (
          checkpointBlock &&
          source === path.join(game, "SkyrimCustom.ini.base") &&
          destination === path.join(wasPrivate ? saved : backup, "SkyrimCustom.ini")
        ) {
          checkpointBlock = false;
          await fs.mkdir(recoveryFile + ".tmp");
        }
      }),
    forcePerm: (_translate, operation) => operation(),
    makeFileWritableAsync: () => Bluebird.resolve(),
  };
  const showError = vi.fn();
  const load = (filename: string, overrides: Record<string, unknown>): any => {
    const module = new Module(filename);
    module.filename = filename;
    const localRequire = createRequire(filename);
    module.paths = localRequire.resolve.paths("bluebird")!;
    module.require = (id) => {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id.startsWith("."))
        return load(path.resolve(path.dirname(filename), id + ".ts"), overrides);
      return localRequire(id);
    };
    (module as any)._compile(
      ts.transpileModule(require("node:fs").readFileSync(filename, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText,
      filename,
    );
    return module.exports;
  };
  let work: PromiseLike<unknown>[] = [];
  let h: ReturnType<typeof makeApiHarness>;
  let deployOverride: (callback: (err: Error | null) => void, profileId: string) => void;
  const drain = async () => {
    let count = -1;
    while (count !== work.length) {
      count = work.length;
      await Promise.all(work);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const start = async (
    persisted?: ReturnType<typeof makeApiHarness>["getState"] extends () => infer S ? S : never,
  ) => {
    work = [];
    h = makeApiHarness(
      {
        profiles: {
          ...(enderal
            ? {
                e: makeProfile({
                  id: "e",
                  gameId: enderalId,
                  features: { local_game_settings: enderal.privateSettings },
                }),
              }
            : {}),
          p: makeProfile({
            id: "p",
            gameId,
            features: { local_game_settings: wasPrivate },
            modState: { tweak: { enabled: true, enabledTime: 1 } },
          }),
          q: makeProfile({ id: "q", gameId, features: { local_game_settings: false } }),
          g: makeProfile({ id: "g", gameId, features: { local_game_settings: false } }),
          other: makeProfile({ id: "other", gameId: "other" }),
        },
        activeProfileId: "p",
        lastActiveProfile: {
          [gameId]: "p",
          other: "other",
          ...(enderal ? { [enderalId]: "e" } : {}),
        },
        discovered: enderal ? { [enderalId]: { path: enderal.installation } } : {},
        installPath: { [gameId]: mods },
        mods: {
          [gameId]: {
            tweak: {
              id: "tweak",
              installationPath: "tweak",
              enabledINITweaks: [tweakName],
              state: "installed",
              attributes: {},
            } as never,
          },
        },
      },
      [
        { path: ["persistent", "profiles"], reducer: profilesReducer },
        { path: ["settings", "profiles"], reducer: settingsReducer },
      ],
    );
    h.setState((state) => {
      if (persisted) {
        state.persistent = { ...state.persistent, ...persisted.persistent };
        state.settings = { ...state.settings, ...persisted.settings };
      }
      state.session.base = { commandLine: {}, toolsRunning: {}, activity: {} } as never;
      if (enderalPrefix) state.settings.gameMode.discovered[enderalId].protonPrefix = enderalPrefix;
    });
    const watch = h.api.onStateChange.bind(h.api);
    h.api.onStateChange = (keys, callback) =>
      watch(keys, (previous, current) => {
        const operation = (callback as any)(previous, current);
        if (operation?.then) work.push(operation);
        return operation;
      });
    h.api.emitAndAwait = (async (event, ...args) => {
      const results: unknown[] = [];
      await Promise.all(
        h.api.events.listeners(event).map(async (listener) => {
          try {
            const result = await listener(...args);
            if (result != null) results.push(result);
          } catch (err) {
            h.api.showErrorNotification(`Unhandled error in event "${event}"`, err);
          }
        }),
      );
      return results;
    }) as typeof h.api.emitAndAwait;
    const emit = h.api.events.emit.bind(h.api.events);
    h.api.events.emit = ((event, ...args) => {
      if (event === "game-settings-operation") {
        const receive = args[1];
        args[1] = (pending) => {
          work.push(
            pending.then(
              () => undefined,
              () => undefined,
            ),
          );
          receive(pending);
        };
      }
      return emit(event, ...args);
    }) as typeof h.api.events.emit;
    const callbacks: Array<() => void> = [];
    const context = new Proxy(
      { api: h.api, once: (callback: () => void) => callbacks.push(callback) },
      {
        get: (target, key) => (key in target ? target[key] : () => undefined),
      },
    ) as any;
    initProfiles(context);
    h.api.events.on("deploy-mods", (callback, profileId) =>
      deployOverride ? deployOverride(callback, profileId) : callback(null),
    );
    const getVortexPath = (key: string) => (key === "documents" ? documents : data);
    load(path.join(repo, "src/renderer/src/extensions/ini_prep/index.ts"), {
      "vortex-parse-ini": { __esModule: true, default: IniParser, IniFile, WinapiFormat },
      "../../logging": { log: () => {} },
      "../../util/CustomErrors": errors,
      "../../util/deepMerge": { __esModule: true, default: deepMerge },
      "../../util/errorHandling": { disableErrorReport: () => {} },
      "../../util/fs": nativeApi,
      "../../util/getVortexPath": { __esModule: true, default: getVortexPath },
      "../../util/selectors": selectors,
      "../../util/storeHelper": { getSafe },
      "../../util/util": { objDiff, setdefault, makeOverlayableDictionary },
      "../mod_management/InstallManager": { INI_TWEAKS_PATH: "INI Tweaks" },
      "../nexus_integration/constants": { NEXUS_DOMAIN: "example.invalid" },
      "../profile_management/selectors": selectors,
      "./TweakList": { default: () => {} },
      "../../util/linux/proton": {
        getMyGamesPath: () => {
          throw new Error("unexpected Proton lookup");
        },
      },
      "../../util/Steam": { __esModule: true, default: { snapshot: () => ({ entries: [] }) } },
    }).default(context);
    load(path.join(repo, "extensions/local-gamesettings/src/index.ts"), {
      "@nexusmods/vortex-api": {
        actions: { setFeature },
        fs: nativeApi,
        log: () => {},
        selectors,
        util: {
          ...errors,
          getSafe,
          makeOverlayableDictionary,
          getVortexPath,
          sortMods: async (_game, mods) => mods,
          showError,
          unique: (values, key) =>
            values.filter(
              (value, index) => values.findIndex((other) => key(value) === key(other)) === index,
            ),
        },
      },
    }).default(context);
    if (saves) {
      const { profileSavePath } = load(
        path.join(repo, "extensions/gamebryo-savegame-management/src/util/profileSavePath.ts"),
        {
          "@nexusmods/vortex-api": { util: { getSafe } },
        },
      );
      const { applySaveSettings } = productionFunctions(
        "extensions/gamebryo-savegame-management/src/index.ts",
        ["applySaveSettings"],
        {
          profileSavePath,
          setSavegamePath: (value) => ({ type: "test-save-path", payload: value }),
        },
      );
      h.api.events.on("apply-settings", (profile, file, ini) => {
        if (file === path.join(game, "Skyrim.ini")) applySaveSettings(h.api, profile, ini);
      });
    }
    callbacks.splice(0).forEach((callback) => {
      const operation = callback() as unknown as PromiseLike<unknown>;
      if (operation?.then) work.push(operation);
    });
    await drain();
  };
  await start();
  const edit = (id: string, enabled: boolean) =>
    h.api.store.dispatch(
      setProfile({
        ...h.getState().persistent.profiles[id],
        features: {
          ...h.getState().persistent.profiles[id].features,
          local_game_settings: enabled,
        },
      }),
    );
  const switchTo = async (id: string) => {
    h.api.store.dispatch(setNextProfile(id));
    await drain();
    expect(h.getState().settings.profiles.activeProfileId).toBe(id);
  };
  const parser = new IniParser(new WinapiFormat());
  const values = async (file: string) => (await parser.read(file)).data;
  return {
    root,
    get recoveryFile() {
      return recoveryFile;
    },
    game,
    get backup() {
      return backup;
    },
    get saved() {
      return saved;
    },
    files,
    enderalGame,
    enderalBackup,
    enderalSaved,
    values,
    profileDirectory: (id: string) => path.join(backup, "profiles", id),
    updateProfile: (id: string, patch: Partial<ReturnType<typeof makeProfile>>) =>
      h.api.store.dispatch(setProfile({ ...h.getState().persistent.profiles[id], ...patch })),
    setDeploy: (operation: typeof deployOverride) => {
      deployOverride = operation;
    },
    beforeConfirmation: (operation: () => PromiseLike<void>) =>
      h.api.events.on("profile-will-change", (_id, enqueue) =>
        enqueue(() => Bluebird.resolve(operation())),
      ),
    bakeProfile: (id: string) =>
      h.api.emitAndAwait("bake-settings", gameId, [], h.getState().persistent.profiles[id], {
        reportResult: true,
      }),
    edit,
    switchTo,
    enableTweak: (enabled: boolean) =>
      h.api.store.dispatch(
        setProfile({
          ...h.getState().persistent.profiles.p,
          modState: { tweak: { enabled, enabledTime: 1 } },
        }),
      ),
    setSaves: (enabled: boolean) =>
      h.api.store.dispatch(
        setProfile({
          ...h.getState().persistent.profiles.p,
          features: { ...h.getState().persistent.profiles.p.features, local_saves: enabled },
        }),
      ),
    changePrefix: (prefix?: string) =>
      h.setState((state) => {
        state.settings.gameMode.discovered[gameId].protonPrefix = prefix;
      }),
    queueSwitch: (id: string) => h.api.store.dispatch(setNextProfile(id)),
    drain,
    showError,
    obstruct: (suffix: string) => {
      blockedFile = path.join(game, "SkyrimPrefs.ini" + suffix);
      block = true;
    },
    repair: async () => {
      await fs.rmdir(blockedFile);
      await fs.rename(blockedFile + ".held", blockedFile);
    },
    blockCheckpoint: () => {
      checkpointBlock = true;
    },
    failSeed: () => {
      seedFailure = true;
    },
    onApply: (listener: (...args: any[]) => unknown) => h.api.events.on("apply-settings", listener),
    setForcePerm: (operation: typeof nativeApi.forcePerm) => {
      nativeApi.forcePerm = operation;
    },
    legacyBake: async () =>
      h.api.emitAndAwait("bake-settings", gameId, [], h.getState().persistent.profiles.p),
    deploymentBake: () =>
      productionFunctions(
        "src/renderer/src/extensions/mod_management/index.ts",
        ["shouldSuppressUpdate", "bakeSettings"],
        {
          getSafe,
          log: () => {},
        },
      ).bakeSettings(
        h.api,
        h.getState().persistent.profiles.p,
        Object.values(h.getState().persistent.mods[gameId]),
      ),
    activate: () => h.api.events.emit("gamemode-activated", gameId),
    purge: () => h.api.events.emit("purge-mods"),
    queueOperation: (operation: () => PromiseLike<unknown>) => {
      let pending: PromiseLike<unknown>;
      h.api.events.emit("game-settings-operation", operation, (result) => {
        pending = result;
      });
      return pending;
    },
    bakeResult: () =>
      h.api.emitAndAwait("bake-settings", gameId, [], h.getState().persistent.profiles.p, {
        reportResult: true,
      }),
    setCopy: (operation: typeof copyOverride) => {
      copyOverride = operation;
    },
    setFileOperation: (name: "renameAsync" | "writeFileAsync" | "unlinkAsync", operation) => {
      nativeApi[name] = (...args) => Bluebird.resolve(operation(...args));
    },
    importProfile: async (withOwnership: boolean) => {
      await drain();
      const source = data;
      const database = path.join(source, "state.v2");
      await fs.mkdir(database);
      await fs.writeFile(path.join(database, "CURRENT"), "MANIFEST-000001\n");
      await fs.writeFile(path.join(database, "LOCK"), "");
      const { flattenState } = load(path.join(repo, "src/main/src/store/flattenState.ts"), {});
      const { persistent, settings } = h.getState();
      const rows = flattenState(JSON.parse(JSON.stringify({ persistent, settings }))).map(
        ({ key, value }) => ({ key, value: JSON.stringify(value) }),
      );
      await fs.writeFile(path.join(database, "test-state.json"), JSON.stringify(rows));
      if (!withOwnership) await fs.unlink(recoveryFile);
      const config = path.join(root, "config");
      await fs.mkdir(config);
      const importer = path.join(repo, "scripts/import-linux-profile.mjs");
      const { importLinuxProfile } = await import(importer);
      const imported = importLinuxProfile(source, config);
      data = imported.profile;
      recoveryFile = path.join(data, "local-game-settings.json");
      backup = path.join(data, gameId);
      saved = path.join(backup, "profiles", "p");
      const copiedState = path.join(data, "state.v2/test-state.json");
      const entries: Array<{ key: string[]; value: string }> = JSON.parse(
        await fs.readFile(copiedState, "utf8"),
      );
      const values = new Map(entries.map(({ key, value }) => [key.join("###"), value]));
      let transaction: Map<string, string>;
      const { finishProfileImport } = load(path.join(repo, "src/main/src/profileImport.ts"), {});
      await finishProfileImport(
        {
          getAllKVs: async () =>
            [...values].map(([key, value]) => ({ key: key.split("###"), value })),
          removeItem: async (key: string[]) => {
            const prefix = key.join("###");
            for (const entry of values.keys())
              if (entry === prefix || entry.startsWith(prefix + "###")) values.delete(entry);
          },
          setItem: async (key: string[], value: string) => {
            values.set(key.join("###"), value);
          },
          beginTransaction: async () => {
            transaction = new Map(values);
          },
          commitTransaction: async () => {},
          rollbackTransaction: async () => {
            values.clear();
            for (const [key, value] of transaction) values.set(key, value);
          },
        },
        data,
      );
      await fs.writeFile(copiedState, JSON.stringify([...values]));
      const persisted = {} as ReturnType<typeof h.getState>;
      for (const [key, value] of JSON.parse(await fs.readFile(copiedState, "utf8"))) {
        const parts = key.split("###");
        let parent = persisted;
        for (const part of parts.slice(0, -1)) parent = parent[part] ??= {};
        parent[parts.at(-1)] = JSON.parse(value);
      }
      expect(
        JSON.parse(await fs.readFile(path.join(data, "nyastra-import-complete.json"), "utf8"))
          .version,
      ).toBe(2);
      expect(persisted.persistent.profiles.p.features.local_game_settings).toBe(
        persistent.profiles.p.features.local_game_settings,
      );
      await start(persisted);
      return source;
    },
    state: () => structuredClone(h.getState()),
    persistState: async () => {
      const directory = await fs.mkdtemp(path.join(root, "native-state-"));
      const overrides = {
        "@vortex/shared": { unknownToError },
        "@vortex/shared/errors": { DataInvalid, VortexError },
        "@vortex/shared/state": sharedState,
        "../logging": { log: () => {} },
        "../getVortexPath": { getVortexPath: () => root },
        "../errorHandling": {
          terminate: (error: Error) => {
            throw error;
          },
        },
      };
      const singleton = load(
        path.join(repo, "src/main/src/store/DuckDBSingleton.ts"),
        overrides,
      ).default.getInstance();
      const bindings = {
        ...overrides,
        "./DuckDBSingleton": { __esModule: true, default: singleton.constructor },
      };
      const LevelPersist = load(
        path.join(repo, "src/main/src/store/LevelPersist.ts"),
        bindings,
      ).default;
      const ReduxPersistorIPC = load(
        path.join(repo, "src/main/src/store/ReduxPersistorIPC.ts"),
        bindings,
      ).default;
      const SubPersistor = load(
        path.join(repo, "src/main/src/store/SubPersistor.ts"),
        bindings,
      ).default;
      const { flattenState } = load(
        path.join(repo, "src/main/src/store/flattenState.ts"),
        bindings,
      );
      const extensionCache = path.join(directory, "duckdb-extensions");
      await fs.cp(path.join(repo, "src/main/build/duckdb-extensions"), extensionCache, {
        recursive: true,
      });
      const open = async () => {
        await singleton.initialize(extensionCache);
        const alias = singleton.nextAlias();
        return new LevelPersist(
          await singleton.attachDatabase(path.join(directory, "state.v2"), alias),
          alias,
        );
      };
      let database;
      try {
        database = await open();
        const persistor = new ReduxPersistorIPC();
        for (const hive of ["settings", "persistent"]) {
          await persistor.insertPersistor(hive, new SubPersistor(database, hive));
          persistor.applyDiffOperations(
            hive,
            flattenState(JSON.parse(JSON.stringify(h.getState()[hive]))).map(({ key, value }) => ({
              type: "set",
              path: key,
              value,
            })),
          );
        }
        await persistor.finalizeWrite();
        await database.close();
        singleton.close();
        database = await open();
        const hydration = new ReduxPersistorIPC();
        for (const hive of ["settings", "persistent"])
          await hydration.insertPersistor(hive, new SubPersistor(database, hive));
        return (await hydration.getAllHydrationData()) as ReturnType<typeof h.getState>;
      } finally {
        if (database) await database.close();
        singleton.close();
      }
    },
    errors: () => h.errorNotifications,
    restart: async (state = structuredClone(h.getState())) => {
      await drain();
      await start(state);
    },
    cleanup: async () => {
      await drain();
      await fs.rm(root, { recursive: true, force: true });
      await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      resetHarnessRegistries();
    },
  };
}

test.each(["active", "inactive", "enable-restart", "disable-restart", "queued-restart"])(
  "recovers private settings and bakes enabled tweaks: %s",
  async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const wasPrivate = mode === "disable-restart";
    const f = await recoveryFixture(wasPrivate);
    try {
      // Copying a later file fails after other files have changed ownership.
      f.obstruct(mode.endsWith("restart") ? ".base" : ".baked");
      f.edit("p", !wasPrivate);
      if (mode === "queued-restart") f.queueSwitch("other");
      await f.drain();
      expect(f.showError).toHaveBeenCalledWith(
        expect.anything(),
        "An error occurred applying game settings",
        expect.anything(),
      );
      expect((await f.values(path.join(f.game, "Skyrim.ini.base"))) as any).toEqual({
        General: { owner: wasPrivate ? "global" : "private", tweak: "0" },
      });
      if (mode.endsWith("restart")) await f.restart();
      await f.repair();
      if (mode === "active") f.edit("p", wasPrivate);
      else f.edit("q", true);
      await f.drain();
      if (mode === "active") {
        f.edit("p", true);
        await f.drain();
      } else if (mode.endsWith("restart")) {
        await f.switchTo("other");
        await f.switchTo("g");
        f.edit("p", true);
        await f.drain();
        await f.switchTo("p");
      }
      const owner = wasPrivate ? "latest" : "private";
      for (const suffix of ["", ".baked"])
        expect((await f.values(path.join(f.game, "Skyrim.ini" + suffix))) as any).toEqual({
          General: { owner, tweak: "1" },
        });
      for (const file of f.files) {
        expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe(
          wasPrivate ? "latest" : "private",
        );
        expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
      }
      await f.switchTo("g");
      for (const file of f.files)
        expect(((await f.values(path.join(f.game, file))) as any).General.owner).toBe("global");
      expect(f.errors()).toEqual([]);
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("keeps a failed production bake recoverable across restart", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  const blocked = path.join(f.game, "SkyrimPrefs.ini");
  try {
    let fail = true;
    f.onApply(async (_profile, file, ini) => {
      if (fail && file === blocked && ini.data.General.owner === "private") {
        fail = false;
        await fs.rename(blocked, blocked + ".held");
        await fs.mkdir(blocked);
      }
    });
    f.edit("p", true);
    await f.drain();
    expect(f.showError).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending.completed).toBe(1);
    expect(((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.tweak).toBe("1");
    await f.restart();
    await fs.rmdir(blocked);
    await fs.rename(blocked + ".held", blocked);
    f.edit("q", true);
    await f.drain();
    for (const suffix of ["", ".baked"])
      expect((await f.values(path.join(f.game, "Skyrim.ini" + suffix))) as any).toEqual({
        General: { owner: "private", tweak: "1" },
      });
    expect(((await f.values(path.join(f.game, "Skyrim.ini.base"))) as any).General.tweak).toBe("0");
    expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
    expect(f.errors()).toEqual([]);
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each([false, true])(
  "replays a snapshot when its checkpoint cannot be published, private=%s",
  async (wasPrivate) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(wasPrivate);
    try {
      f.blockCheckpoint();
      f.edit("p", !wasPrivate);
      await f.drain();
      expect(f.showError).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending.completed).toBe(0);
      for (const file of f.files)
        expect(((await f.values(path.join(f.game, file + ".base"))) as any).General.owner).toBe(
          wasPrivate ? "latest" : "global",
        );
      await fs.rmdir(f.recoveryFile + ".tmp");
      // A torn unpublished write cannot replace the last complete checkpoint.
      await fs.writeFile(f.recoveryFile + ".tmp", '{"pending":');
      await f.restart();
      f.edit("q", true);
      await f.drain();
      const owner = wasPrivate ? "global" : "private";
      for (const file of f.files) {
        expect(((await f.values(path.join(f.game, file))) as any).General.owner).toBe(owner);
        expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe(
          wasPrivate ? "latest" : "private",
        );
        expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
      }
      expect(((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.tweak).toBe("1");
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
      await expect(fs.stat(f.recoveryFile + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
      expect(f.errors()).toEqual([]);
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("does not publish an interrupted first-use seed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  const seed = path.join(f.saved, "Skyrim.ini");
  try {
    await fs.unlink(seed);
    f.failSeed();
    f.edit("p", true);
    await f.drain();
    expect(f.showError).toHaveBeenCalledTimes(1);
    await expect(fs.stat(seed)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(seed + ".settings.tmp")).rejects.toMatchObject({ code: "ENOENT" });
    await f.restart();
    f.edit("q", true);
    await f.drain();
    expect((await f.values(seed)) as any).toEqual({ General: { owner: "global", tweak: "0" } });
    expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
      General: { owner: "global", tweak: "1" },
    });
    expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
    expect(f.errors()).toEqual([]);
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test("retains installed ownership when Redux persistence trails a completed swap", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  try {
    const stale = f.state();
    f.edit("p", true);
    await f.drain();
    expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
    await f.restart(stale);
    await f.switchTo("other");
    await f.switchTo("g");
    for (const file of f.files) {
      expect(((await f.values(path.join(f.game, file))) as any).General.owner).toBe("global");
      expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("private");
    }
    expect(f.showError).not.toHaveBeenCalled();
    expect(f.errors()).toEqual([]);
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each(["invalid", "new-version", "changed-path"])(
  "blocks unsafe recovery data: %s",
  async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false);
    try {
      f.obstruct(".base");
      f.edit("p", true);
      await f.drain();
      await f.repair();
      const recovery = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
      if (mode === "new-version") recovery.version = 2;
      if (mode === "changed-path")
        recovery.pending.steps[1].destinationPath = path.join(f.root, "wrong");
      const bytes = mode === "invalid" ? '{"pending":' : JSON.stringify(recovery);
      await fs.writeFile(f.recoveryFile, bytes);
      const before = await Promise.all(
        f.files.map((file) => fs.readFile(path.join(f.saved, file), "utf8")),
      );
      await f.restart();
      expect(f.errors()).toEqual([
        expect.objectContaining({ title: "Failed to recover game settings" }),
      ]);
      f.edit("q", true);
      await f.drain();
      expect(f.errors()).toEqual([
        expect.objectContaining({ title: "Failed to recover game settings" }),
      ]);
      expect(await fs.readFile(f.recoveryFile, "utf8")).toBe(bytes);
      expect(
        await Promise.all(f.files.map((file) => fs.readFile(path.join(f.saved, file), "utf8"))),
      ).toEqual(before);
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("keeps legacy bake callers' error handling", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  try {
    const baked = path.join(f.game, "Skyrim.ini.baked");
    await fs.unlink(baked);
    await fs.mkdir(baked);
    await expect(f.legacyBake()).resolves.toEqual([]);
    expect(f.errors()).toEqual([
      expect.objectContaining({ title: "Failed to bake settings files" }),
    ]);
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test("awaits sibling discovery writes before reporting a bake failure", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const broken = path.join(f.game, "Skyrim.ini.baked");
    await fs.unlink(broken);
    await fs.mkdir(broken);
    await fs.writeFile(path.join(f.game, "SkyrimPrefs.ini"), "[General]\nowner=manual\ntweak=0\n");
    f.setForcePerm((_translate, operation) => {
      entered();
      return Bluebird.resolve(held).then(operation);
    });
    f.edit("p", true);
    await ready;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.errors()).toEqual([]);
    expect(f.showError).not.toHaveBeenCalled();
    release();
    await f.drain();
    expect(f.errors()).toEqual([]);
    expect(f.showError).toHaveBeenCalledWith(
      expect.anything(),
      "An error occurred applying game settings",
      expect.objectContaining({ error: expect.objectContaining({ code: "EISDIR" }) }),
    );
    expect(((await f.values(path.join(f.game, "SkyrimPrefs.ini.base"))) as any).General.owner).toBe(
      "manual",
    );
    expect(((await f.values(path.join(f.saved, "SkyrimPrefs.ini"))) as any).General.owner).toBe(
      "private",
    );
  } finally {
    release();
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test("confirms a production bake with a plain INI tweak filename", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false, "skyrim.ini");
  try {
    f.edit("p", true);
    await f.drain();
    expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
      General: { owner: "private", tweak: "1" },
    });
    expect(f.showError).not.toHaveBeenCalled();
    expect(f.errors()).toEqual([]);
    expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each([false, true])(
  "recovers an absent optional INI with an enabled custom tweak=%s",
  async (customTweak) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(
      false,
      customTweak ? "test[skyrimcustom].ini" : "test[skyrim].ini",
    );
    try {
      await fs.unlink(path.join(f.saved, "SkyrimCustom.ini"));
      f.obstruct(".base");
      f.edit("p", true);
      await f.drain();
      expect(f.showError).toHaveBeenCalledTimes(1);
      await f.restart();
      await f.repair();
      f.edit("q", true);
      await f.drain();
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
      if (customTweak) {
        expect((await f.values(path.join(f.game, "SkyrimCustom.ini"))) as any).toEqual({
          General: { tweak: "1" },
        });
      } else {
        for (const suffix of ["", ".base", ".baked"])
          await expect(
            fs.stat(path.join(f.game, "SkyrimCustom.ini" + suffix)),
          ).rejects.toMatchObject({ code: "ENOENT" });
        expect(((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.tweak).toBe("1");
      }
      await f.switchTo("g");
      expect(((await f.values(path.join(f.game, "SkyrimCustom.ini"))) as any).General.owner).toBe(
        "global",
      );
      expect(f.errors()).toEqual([]);
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("blocks a path change during same-session recovery until the original path returns", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  try {
    f.obstruct(".base");
    f.edit("p", true);
    await f.drain();
    await f.repair();
    const before = await fs.readFile(f.recoveryFile, "utf8");
    f.changePrefix(path.join(f.root, "different-prefix"));
    f.edit("q", true);
    await f.drain();
    expect(await fs.readFile(f.recoveryFile, "utf8")).toBe(before);
    expect(f.showError).toHaveBeenLastCalledWith(
      expect.anything(),
      "An error occurred applying game settings",
      expect.objectContaining({
        error: expect.objectContaining({ message: "Game settings paths changed during recovery" }),
      }),
    );
    f.changePrefix();
    f.edit("q", false);
    await f.drain();
    expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
    expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
      General: { owner: "private", tweak: "1" },
    });
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test("bakes the persisted mod selection after restart recovery", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  try {
    f.obstruct(".base");
    f.edit("p", true);
    await f.drain();
    f.enableTweak(false);
    await f.drain();
    await f.restart();
    await f.repair();
    f.edit("q", true);
    await f.drain();
    expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
      General: { owner: "private", tweak: "0" },
    });
    expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
    expect(f.errors()).toEqual([]);
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each(
  [false, true].flatMap((wasPrivate) =>
    ["checkpoint", "preceding-bake"].flatMap((failure) =>
      [false, true].map((addedGame) => ({ wasPrivate, failure, addedGame })),
    ),
  ),
)(
  "preserves ownership after the first $failure fails and restart, private=$wasPrivate, added game=$addedGame",
  async ({ wasPrivate, failure, addedGame }) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(wasPrivate);
    const blocked =
      failure === "checkpoint"
        ? f.recoveryFile + ".tmp"
        : path.join(f.game, "SkyrimPrefs.ini.baked");
    try {
      if (addedGame) {
        const recovery = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
        delete recovery.installed.skyrimse;
        await fs.writeFile(f.recoveryFile, JSON.stringify(recovery));
        await f.restart();
      }
      if (failure === "preceding-bake") await fs.rename(blocked, blocked + ".held");
      await fs.mkdir(blocked);
      f.edit("p", !wasPrivate);
      await f.drain();
      expect(f.showError.mock.calls.length + f.errors().length).toBeGreaterThan(0);
      await fs.rmdir(blocked);
      if (failure === "preceding-bake") await fs.rename(blocked + ".held", blocked);
      await f.restart();
      await f.switchTo("other");
      await f.switchTo("g");
      for (const file of f.files) {
        expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe(
          wasPrivate ? "latest" : "private",
        );
        expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
        expect(((await f.values(path.join(f.game, file))) as any).General.owner).toBe("global");
      }
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each([false, true])(
  "deployment bake and private enable share a lifecycle, concurrent=%s",
  async (concurrent) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let paused = false;
    let deployment: PromiseLike<unknown> | undefined;
    try {
      await fs.writeFile(
        path.join(f.game, "Skyrim.ini"),
        "[General]\nowner=edited-global\ntweak=0\n",
      );
      f.setForcePerm((_translate, operation) =>
        Bluebird.try(async () => {
          if (concurrent && !paused) {
            paused = true;
            entered();
            await held;
          }
          return operation();
        }),
      );
      deployment = f.deploymentBake();
      if (concurrent) await ready;
      else await deployment;
      f.edit("p", true);
      if (concurrent) {
        await waitForIO(200);
        release();
      }
      await deployment;
      await f.drain();
      expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
        General: { owner: "private", tweak: "1" },
      });
      await f.switchTo("g");
      for (const file of f.files) {
        expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("private");
        expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe(
          file === "Skyrim.ini" ? "edited-global" : "global",
        );
      }
      expect(f.errors()).toEqual([]);
    } finally {
      release();
      await deployment;
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each([false, true])(
  "recovery uses current private save settings, restart=%s",
  async (restart) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false, "test[skyrim].ini", true);
    try {
      f.setSaves(true);
      f.obstruct(".base");
      f.edit("p", true);
      await f.drain();
      f.setSaves(false);
      await f.drain();
      if (restart) await f.restart();
      await f.repair();
      f.edit("q", true);
      await f.drain();
      expect(
        ((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.SLocalSavePath,
      ).toBe("Saves" + path.sep);
      expect(((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.tweak).toBe("1");
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each([false, true])(
  "startup resumes repaired pending settings without a feature edit, private=%s",
  async (wasPrivate) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(wasPrivate);
    try {
      f.obstruct(".base");
      f.edit("p", !wasPrivate);
      await f.drain();
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeDefined();
      await f.repair();
      await f.restart();
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
      expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
        General: { owner: wasPrivate ? "global" : "private", tweak: "1" },
      });
      await f.switchTo("g");
      for (const file of f.files) {
        expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe(
          wasPrivate ? "latest" : "private",
        );
        expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
      }
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each([false, true])(
  "rejects feature edits if initial ownership cannot be saved, private=%s",
  async (wasPrivate) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(wasPrivate, "test[skyrim].ini", false, true);
    try {
      expect(f.errors()).toEqual([
        expect.objectContaining({ title: "Failed to recover game settings" }),
      ]);
      f.edit("p", !wasPrivate);
      await f.drain();
      expect(f.state().persistent.profiles.p.features.local_game_settings).toBe(wasPrivate);
      f.queueSwitch("q");
      await f.drain();
      expect(f.state().settings.profiles.activeProfileId).toBe("p");
      await expect(fs.stat(f.recoveryFile)).rejects.toMatchObject({ code: "ENOENT" });
      for (const file of f.files) {
        expect(((await f.values(path.join(f.game, file))) as any).General.owner).toBe(
          wasPrivate ? "latest" : "global",
        );
        expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("private");
        expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
      }
      await fs.rmdir(f.recoveryFile + ".tmp");
      await f.restart();
      await f.switchTo("other");
      await f.switchTo("g");
      for (const file of f.files) {
        expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe(
          wasPrivate ? "latest" : "private",
        );
        expect(((await f.values(path.join(f.game, file))) as any).General.owner).toBe("global");
      }
      expect(f.errors()).toEqual([]);
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("replays the final bake when publishing completion fails", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  let blocked = false;
  try {
    f.onApply(async (_profile, _file, ini) => {
      if (!blocked && ini.data.General.owner === "private") {
        blocked = true;
        await fs.mkdir(f.recoveryFile + ".tmp");
      }
    });
    f.edit("p", true);
    await f.drain();
    expect(f.showError).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending.completed).toBe(1);
    expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
      General: { owner: "private", tweak: "1" },
    });
    await fs.rmdir(f.recoveryFile + ".tmp");
    await f.restart();
    expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
    expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
      General: { owner: "private", tweak: "1" },
    });
    expect(((await f.values(path.join(f.game, "Skyrim.ini.base"))) as any).General.tweak).toBe("0");
    await f.switchTo("g");
    for (const file of f.files) {
      expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("private");
      expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
    }
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test("a deployment bake waits for the in-progress private enable", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let paused = false;
  let finished = false;
  let deployment: Promise<unknown> | undefined;
  try {
    f.onApply(async (_profile, file, ini) => {
      if (
        !paused &&
        file === path.join(f.game, "Skyrim.ini") &&
        ini.data.General.owner === "private"
      ) {
        paused = true;
        entered();
        await held;
      }
    });
    f.edit("p", true);
    await ready;
    deployment = f.deploymentBake().then(() => {
      finished = true;
    });
    await waitForIO(100);
    expect(finished).toBe(false);
    release();
    await deployment;
    await f.drain();
    expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
      General: { owner: "private", tweak: "1" },
    });
    await f.switchTo("g");
    expect(((await f.values(path.join(f.saved, "Skyrim.ini"))) as any).General.owner).toBe(
      "private",
    );
    expect(((await f.values(path.join(f.backup, "Skyrim.ini"))) as any).General.owner).toBe(
      "global",
    );
  } finally {
    release();
    await deployment;
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each([false, true])(
  "imports global INI backups and persisted active settings, ownership=%s",
  async (withOwnership) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(true);
    try {
      const source = await f.importProfile(withOwnership);
      f.edit("p", false);
      await f.drain();
      for (const file of f.files) {
        expect(((await f.values(path.join(f.game, file))) as any).General.owner).toBe("global");
        expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
        expect(((await f.values(path.join(source, "skyrimse", file))) as any).General.owner).toBe(
          "global",
        );
        expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("latest");
      }
      await f.restart();
      f.edit("p", true);
      await f.drain();
      expect(((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.owner).toBe(
        "latest",
      );
      expect(f.errors()).toEqual([]);
      expect(f.showError).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each([
  { wasPrivate: false, activate: false, restart: false },
  { wasPrivate: false, activate: true, restart: false },
  { wasPrivate: true, activate: true, restart: false },
  { wasPrivate: false, activate: true, restart: true },
])("retries settings recovery after activation: %j", async ({ wasPrivate, activate, restart }) => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(wasPrivate);
  try {
    f.obstruct(".base");
    f.edit("p", !wasPrivate);
    await f.drain();
    if (restart) await f.restart();
    if (activate) {
      f.activate();
      await f.drain();
    }
    expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeDefined();
    await f.repair();
    f.edit("q", true);
    await f.drain();
    expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
    expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
      General: { owner: wasPrivate ? "global" : "private", tweak: "1" },
    });
    await f.switchTo("g");
    for (const file of f.files) {
      expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe(
        wasPrivate ? "latest" : "private",
      );
      expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
    }
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each([
  "present",
  "absent",
  "custom-tweak",
  "missing-required",
  "missing-sidecar",
  "denied-optional",
])("deployment handles its declared INI files: %s", async (mode) => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(
    false,
    mode === "custom-tweak" ? "skyrimcustom.ini" : "skyrim.ini",
  );
  try {
    if (mode === "absent" || mode === "custom-tweak") {
      for (const suffix of ["", ".base", ".baked"])
        await fs.unlink(path.join(f.game, "SkyrimCustom.ini" + suffix));
    } else if (mode === "missing-required") {
      await fs.unlink(path.join(f.game, "SkyrimPrefs.ini"));
    } else if (mode === "missing-sidecar") {
      await fs.unlink(path.join(f.game, "SkyrimCustom.ini.baked"));
    } else if (mode === "denied-optional") {
      await fs.chmod(path.join(f.game, "SkyrimCustom.ini"), 0);
    }
    await f.deploymentBake();
    if (["missing-required", "missing-sidecar", "denied-optional"].includes(mode)) {
      expect(f.errors()).toEqual([
        expect.objectContaining({ title: "Failed to bake settings files" }),
      ]);
      expect(((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.tweak).toBe("0");
    } else {
      expect(f.errors()).toEqual([]);
      if (mode === "absent") {
        for (const suffix of ["", ".base", ".baked"])
          await expect(
            fs.stat(path.join(f.game, "SkyrimCustom.ini" + suffix)),
          ).rejects.toMatchObject({ code: "ENOENT" });
      }
      const tweaked = mode === "custom-tweak" ? "SkyrimCustom.ini" : "Skyrim.ini";
      expect(((await f.values(path.join(f.game, tweaked))) as any).General.tweak).toBe("1");
    }
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each([false, true])("switches Starfield profiles with an extra INI=%s", async (extraIni) => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(true, "starfieldprefs.ini", false, false, "starfield");
  try {
    if (extraIni) {
      for (const suffix of ["", ".base", ".baked"])
        await fs.writeFile(path.join(f.game, "Starfield.ini" + suffix), "[General]\nowner=extra\n");
    }
    await f.switchTo("q");
    for (const file of f.files) {
      expect(((await f.values(path.join(f.game, file))) as any).General.owner).toBe("global");
      expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("latest");
    }
    expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).installed.starfield.id).toBe("q");
    await f.switchTo("p");
    expect((await f.values(path.join(f.game, "StarfieldPrefs.ini"))) as any).toEqual({
      General: { owner: "latest", tweak: "1" },
    });
    f.edit("p", false);
    await f.drain();
    expect(((await f.values(path.join(f.game, "StarfieldPrefs.ini"))) as any).General.owner).toBe(
      "global",
    );
    expect(f.errors()).toEqual([]);
    expect(f.showError).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each([false, true])(
  "failed purge drains copies before a private swap, concurrent=%s",
  async (concurrent) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let failed!: () => void;
    const failure = new Promise<void>((resolve) => {
      failed = resolve;
    });
    let optionalCopied!: () => void;
    const optionalReady = new Promise<void>((resolve) => {
      optionalCopied = resolve;
    });
    let finished!: () => void;
    const copied = new Promise<void>((resolve) => {
      finished = resolve;
    });
    let delayed = false;
    let rejected = false;
    try {
      f.setCopy(async (source, destination, copy) => {
        if (
          !delayed &&
          source === path.join(f.game, "Skyrim.ini.base") &&
          destination.startsWith(path.join(f.game, "Skyrim.ini.baked.")) &&
          destination.endsWith(".live.tmp")
        ) {
          delayed = true;
          const bytes = await fs.readFile(source);
          entered();
          await held;
          await fs.writeFile(destination, bytes);
          finished();
        } else if (
          !rejected &&
          source === path.join(f.game, "SkyrimPrefs.ini.base") &&
          destination.startsWith(path.join(f.game, "SkyrimPrefs.ini.baked.")) &&
          destination.endsWith(".tmp")
        ) {
          rejected = true;
          await Promise.all([ready, optionalReady]);
          failed();
          throw Object.assign(new Error("purge copy failed"), { code: "EIO" });
        } else {
          await copy();
          if (
            source === path.join(f.game, "SkyrimCustom.ini.base") &&
            destination.startsWith(path.join(f.game, "SkyrimCustom.ini.baked.")) &&
            destination.endsWith(".live.tmp")
          )
            optionalCopied();
        }
      });
      f.purge();
      await failure;
      if (concurrent) {
        f.edit("p", true);
        await waitForIO(150);
        expect
          .soft(((await f.values(path.join(f.game, "SkyrimPrefs.ini.base"))) as any).General.owner)
          .toBe("global");
      }
      release();
      await copied;
      await f.drain();
      if (!concurrent) {
        f.edit("p", true);
        await f.drain();
      }
      expect(f.showError.mock.calls).toEqual([]);
      expect(f.errors()).toEqual([expect.objectContaining({ title: "Failed to purge ini edits" })]);
      expect(f.state().persistent.profiles.p.features.local_game_settings).toBe(true);
      expect(
        JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).installed.skyrimse.features
          .local_game_settings,
      ).toBe(true);
      for (const file of f.files)
        expect
          .soft(((await f.values(path.join(f.game, file))) as any).General.owner)
          .toBe("private");
      await f.switchTo("g");
      for (const file of f.files) {
        expect
          .soft(((await f.values(path.join(f.saved, file))) as any).General.owner)
          .toBe("private");
        expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
      }
      expect(f.errors()).toEqual([expect.objectContaining({ title: "Failed to purge ini edits" })]);
      expect(f.showError).not.toHaveBeenCalled();
    } finally {
      release();
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each(["same-file", "other-file"])(
  "backup failure drains all copies and retains its safety stop: %s",
  async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let failed!: () => void;
    const failure = new Promise<void>((resolve) => {
      failed = resolve;
    });
    let rejected = false;
    let delayed = false;
    let queueRan = false;
    try {
      for (const file of f.files)
        for (const suffix of [".base", ".baked"]) await fs.unlink(path.join(f.game, file + suffix));
      f.setCopy(async (source, destination, copy) => {
        if (!delayed && destination === path.join(f.game, "Skyrim.ini.base")) {
          delayed = true;
          const bytes = await fs.readFile(source);
          entered();
          await held;
          await fs.writeFile(destination, bytes);
        } else if (
          !rejected &&
          destination ===
            path.join(f.game, (mode === "same-file" ? "Skyrim.ini" : "SkyrimPrefs.ini") + ".baked")
        ) {
          rejected = true;
          await ready;
          failed();
          throw Object.assign(new Error("backup copy failed"), { code: "EIO" });
        } else await copy();
      });
      f.activate();
      await failure;
      const next = f.queueOperation(() =>
        Bluebird.try(() => {
          queueRan = true;
        }),
      );
      await waitForIO(75);
      expect.soft(queueRan).toBe(false);
      expect.soft(f.errors()).toEqual([]);
      release();
      await next;
      await f.drain();
      expect(queueRan).toBe(true);
      expect(f.errors()).toEqual([
        expect.objectContaining({
          title: "Failed to create backups of the ini files for this game.",
        }),
      ]);
      expect(await f.bakeResult()).toEqual([expect.objectContaining({ settingsBaked: false })]);
      for (const file of f.files)
        expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("private");
      await f.restart();
      f.activate();
      await f.drain();
      expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
      expect(f.errors()).toEqual([]);
    } finally {
      release();
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each([false, true])("purges with an absent optional INI=%s", async (absent) => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  try {
    if (absent)
      for (const suffix of ["", ".base", ".baked"])
        await fs.unlink(path.join(f.game, "SkyrimCustom.ini" + suffix));
    await f.deploymentBake();
    f.purge();
    await f.drain();
    expect(f.errors()).toEqual([]);
    expect(((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.tweak).toBe("0");
    if (absent)
      for (const suffix of ["", ".base", ".baked"])
        await expect(fs.stat(path.join(f.game, "SkyrimCustom.ini" + suffix))).rejects.toMatchObject(
          { code: "ENOENT" },
        );
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

const isolationCases = ["restart", "activation"].flatMap((trigger) =>
  [false, true].flatMap((privateSettings) =>
    [false, true].map((privateSaves) => ({ trigger, privateSettings, privateSaves })),
  ),
);

async function advanceBlockedRecovery(
  f: Awaited<ReturnType<typeof recoveryFixture>>,
  privateSettings = false,
  privateSaves = false,
) {
  f.setSaves(true);
  f.updateProfile("q", {
    features: { local_game_settings: privateSettings, local_saves: privateSaves },
  });
  await f.drain();
  const q = f.profileDirectory("q");
  await fs.mkdir(q, { recursive: true });
  for (const file of f.files)
    await fs.writeFile(path.join(q, file), "[General]\nowner=q\ntweak=0\n");
  f.obstruct(".base");
  f.edit("p", true);
  await f.drain();
  await f.switchTo("q");
  const pending = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
  expect(pending.version).toBe(1);
  expect(pending.pending.newProfile.id).toBe("p");
  expect(pending.pending.completed).toBe(1);
  return q;
}

test.each(isolationCases)(
  "reconciles recovered P to active Q: $trigger, settings=$privateSettings, saves=$privateSaves",
  async ({ trigger, privateSettings, privateSaves }) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false, "test[skyrim].ini", true);
    try {
      const q = await advanceBlockedRecovery(f, privateSettings, privateSaves);
      expect(f.state().settings.profiles.activeProfileId).toBe("q");
      await f.repair();
      if (trigger === "restart") await f.restart();
      else {
        f.activate();
        await f.drain();
      }
      const live = (await f.values(path.join(f.game, "Skyrim.ini"))) as any;
      expect
        .soft(live.General.SLocalSavePath)
        .toBe(privateSaves ? path.join("Saves", "q") + path.sep : "Saves" + path.sep);
      expect
        .soft(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).installed.skyrimse.id)
        .toBe("q");
      for (const file of f.files) {
        for (const suffix of ["", ".base", ".baked"])
          expect(((await f.values(path.join(f.game, file + suffix))) as any).General.owner).toBe(
            privateSettings ? "q" : "global",
          );
        expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("private");
        expect(((await f.values(path.join(q, file))) as any).General.owner).toBe("q");
        expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
      }
      for (const suffix of ["", ".baked"])
        expect((await f.values(path.join(f.game, "Skyrim.ini" + suffix))) as any).toEqual({
          General: {
            owner: privateSettings ? "q" : "global",
            tweak: "0",
            SLocalSavePath: privateSaves ? path.join("Saves", "q") + path.sep : "Saves" + path.sep,
          },
        });
      const recovered = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
      expect(recovered.pending).toBeUndefined();
      expect(recovered.installed.skyrimse.id).toBe("q");
      expect(recovered.installed.skyrimse.features.local_game_settings).toBe(privateSettings);
      expect(f.state().settings.profiles.activeProfileId).toBe("q");
      await f.switchTo("p");
      expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
        General: {
          owner: "private",
          tweak: "1",
          SLocalSavePath: path.join("Saves", "p") + path.sep,
        },
      });
      await f.switchTo("g");
      expect(((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.owner).toBe(
        "global",
      );
      expect(f.errors()).toEqual([]);
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each(["same-profile", "no-failure"])("profile isolation control: %s", async (mode) => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false, "test[skyrim].ini", true);
  try {
    f.setSaves(true);
    if (mode === "same-profile") f.obstruct(".base");
    f.edit("p", true);
    await f.drain();
    if (mode === "same-profile") {
      await f.repair();
      await f.restart();
    } else await f.switchTo("q");
    expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
      General: {
        owner: mode === "same-profile" ? "private" : "global",
        tweak: mode === "same-profile" ? "1" : "0",
        SLocalSavePath:
          mode === "same-profile" ? path.join("Saves", "p") + path.sep : "Saves" + path.sep,
      },
    });
    expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
    expect(f.errors()).toEqual([]);
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each(["restart", "activation"])(
  "retains a blocked P journal and rejects queued writes under Q: %s",
  async (trigger) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false, "test[skyrim].ini", true);
    try {
      const q = await advanceBlockedRecovery(f);
      const before = await fs.readFile(f.recoveryFile, "utf8");
      if (trigger === "restart") await f.restart();
      else {
        f.activate();
        await f.drain();
      }
      const operation = vi.fn(() => Bluebird.resolve());
      await expect(f.queueOperation(operation)).rejects.toThrow(
        "Game settings recovery is incomplete",
      );
      await f.drain();
      expect(operation).not.toHaveBeenCalled();
      expect(await fs.readFile(f.recoveryFile, "utf8")).toBe(before);
      expect(f.state().settings.profiles.activeProfileId).toBe("q");
      for (const file of f.files) {
        expect(((await f.values(path.join(q, file))) as any).General.owner).toBe("q");
        expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("private");
        expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
      }
      await f.repair();
      f.activate();
      await f.drain();
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
      expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
        General: { owner: "global", tweak: "0", SLocalSavePath: "Saves" + path.sep },
      });
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each(["journal", "snapshot", "global-install", "private-install", "bake"])(
  "retains a failed recovery handoff and retries after restart: %s",
  async (failure) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false, "test[skyrim].ini", true);
    let blocked: string | undefined;
    let original = false;
    let obstructed = false;
    const obstruct = async (file: string, preserve = true) => {
      if (obstructed) return;
      obstructed = true;
      blocked = file;
      original = preserve;
      if (preserve) await fs.rename(file, file + ".held");
      await fs.mkdir(file);
    };
    try {
      const q = await advanceBlockedRecovery(f, failure === "private-install", true);
      await f.repair();
      f.setCopy(async (source, destination, copy) => {
        if (
          (failure === "snapshot" && destination === path.join(f.saved, "SkyrimPrefs.ini")) ||
          (failure.endsWith("install") &&
            source === path.join(failure === "private-install" ? q : f.backup, "SkyrimPrefs.ini") &&
            destination === path.join(f.game, "SkyrimPrefs.ini.base"))
        )
          await obstruct(destination);
        await copy();
      });
      f.onApply(async (profile, file) => {
        if (failure === "journal" && profile.id === "p")
          await obstruct(f.recoveryFile + ".tmp", false);
        if (
          failure === "bake" &&
          profile.id === "q" &&
          file === path.join(f.game, "SkyrimPrefs.ini")
        )
          await obstruct(file);
      });
      f.activate();
      await f.drain();
      expect(obstructed).toBe(true);
      const journal = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
      expect(journal.pending.newProfile.id).toBe(failure === "journal" ? "p" : "q");
      expect(f.showError.mock.calls.length + f.errors().length).toBeGreaterThan(0);
      const operation = vi.fn(() => Bluebird.resolve());
      await expect(f.queueOperation(operation)).rejects.toThrow(
        "Game settings recovery is incomplete",
      );
      expect(operation).not.toHaveBeenCalled();
      for (const file of f.files) {
        const saved = path.join(f.saved, file);
        expect(((await f.values(path.join(q, file))) as any).General.owner).toBe("q");
        expect(
          ((await f.values(saved + (blocked === saved ? ".held" : ""))) as any).General.owner,
        ).toBe("private");
        expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
      }
      await fs.rmdir(blocked!);
      if (original) await fs.rename(blocked! + ".held", blocked!);
      blocked = undefined;
      f.setCopy(undefined);
      await f.restart();
      expect(f.state().settings.profiles.activeProfileId).toBe("q");
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
      expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
        General: {
          owner: failure === "private-install" ? "q" : "global",
          tweak: "0",
          SLocalSavePath: path.join("Saves", "q") + path.sep,
        },
      });
      expect(f.errors()).toEqual([]);
      await f.switchTo("p");
      expect(((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.owner).toBe(
        "private",
      );
    } finally {
      if (blocked) {
        await fs.rmdir(blocked);
        if (original) await fs.rename(blocked + ".held", blocked);
      }
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each([false, true])(
  "reconciles the last active game while another game is active, private=%s",
  async (privateSettings) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false, "test[skyrim].ini", true);
    try {
      await advanceBlockedRecovery(f, privateSettings, true);
      await f.switchTo("other");
      expect(f.state().settings.profiles.lastActiveProfile.skyrimse).toBe("q");
      await f.repair();
      await f.restart();
      expect(f.state().settings.profiles.activeProfileId).toBe("other");
      expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
        General: {
          owner: privateSettings ? "q" : "global",
          tweak: "0",
          SLocalSavePath: path.join("Saves", "q") + path.sep,
        },
      });
      const journal = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
      expect(journal.installed.skyrimse.id).toBe("q");
      expect(journal.installed.other.id).toBe("other");
      expect(journal.pending).toBeUndefined();
      await f.switchTo("q");
      await f.switchTo("p");
      expect(((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.owner).toBe(
        "private",
      );
      expect(f.errors()).toEqual([]);
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("recovery respects the profile switch while deployment awaits core confirmation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false, "test[skyrim].ini", true);
  let complete: (err: Error | null) => void = () => {};
  let entered: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    f.setSaves(true);
    f.updateProfile("q", { features: { local_game_settings: false, local_saves: true } });
    await f.drain();
    f.obstruct(".base");
    f.edit("p", true);
    await f.drain();
    f.setDeploy((callback, profileId) => {
      expect(profileId).toBe("q");
      complete = (err) => {
        complete = () => {};
        callback(err);
      };
      entered();
    });
    f.queueSwitch("q");
    await ready;
    expect(f.state().settings.profiles.activeProfileId).toBe("p");
    expect(f.state().settings.profiles.nextProfileId).toBe("q");
    await f.repair();
    expect(await f.bakeProfile("q")).toEqual([{ settingsBaked: true }]);
    expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
      General: { owner: "global", tweak: "0", SLocalSavePath: path.join("Saves", "q") + path.sep },
    });
    expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).installed.skyrimse.id).toBe("q");
    complete(null);
    await f.drain();
    expect(f.state().settings.profiles.activeProfileId).toBe("q");
    expect(((await f.values(path.join(f.saved, "Skyrim.ini"))) as any).General.owner).toBe(
      "private",
    );
    expect(f.errors()).toEqual([]);
  } finally {
    f.setDeploy(undefined);
    complete(null);
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each(["feature-edit", "profile-switch"])(
  "orders recovery with a concurrent %s",
  async (race) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false, "test[skyrim].ini", true);
    let release: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let queued: PromiseLike<unknown> | undefined;
    let delayed = false;
    try {
      const q = await advanceBlockedRecovery(f, true, true);
      await f.repair();
      f.setCopy(async (source, destination, copy) => {
        if (
          !delayed &&
          source === path.join(q, "Skyrim.ini") &&
          destination === path.join(f.game, "Skyrim.ini.base")
        ) {
          delayed = true;
          const bytes = await fs.readFile(source);
          entered();
          await held;
          await fs.writeFile(destination, bytes);
        } else await copy();
      });
      f.activate();
      await ready;
      if (race === "profile-switch") f.queueSwitch("g");
      else
        f.updateProfile("q", {
          features: { local_game_settings: true, local_saves: false },
          modState: { tweak: { enabled: true, enabledTime: 2 } },
        });
      const operation = vi.fn(async () => {
        expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
        expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
          General: {
            owner: race === "profile-switch" ? "global" : "q",
            tweak: race === "profile-switch" ? "0" : "1",
            SLocalSavePath: "Saves" + path.sep,
          },
        });
      });
      queued = f.queueOperation(() => Bluebird.resolve(operation()));
      await waitForIO(50);
      expect(operation).not.toHaveBeenCalled();
      release();
      await queued;
      await f.drain();
      expect(operation).toHaveBeenCalledTimes(1);
      expect(f.state().settings.profiles.activeProfileId).toBe(
        race === "profile-switch" ? "g" : "q",
      );
      for (const file of f.files) {
        expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("private");
        expect(((await f.values(path.join(q, file))) as any).General.owner).toBe("q");
        expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
      }
      expect(f.errors()).toEqual([]);
    } finally {
      release();
      await queued?.then(
        () => undefined,
        () => undefined,
      );
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each(["removed", "different-game"])(
  "blocks an unavailable reconciliation target: %s",
  async (change) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false, "test[skyrim].ini", true);
    try {
      const q = await advanceBlockedRecovery(f);
      f.updateProfile("q", change === "removed" ? { pendingRemove: true } : { gameId: "other" });
      await f.drain();
      await f.repair();
      const before = await fs.readFile(f.recoveryFile, "utf8");
      f.activate();
      await f.drain();
      expect(f.showError).toHaveBeenLastCalledWith(
        expect.anything(),
        "An error occurred applying game settings",
        expect.objectContaining({
          error: expect.objectContaining({
            message: "Game settings recovery profile is unavailable",
          }),
        }),
      );
      expect(await fs.readFile(f.recoveryFile, "utf8")).toBe(before);
      for (const file of f.files)
        expect(((await f.values(path.join(q, file))) as any).General.owner).toBe("q");
      f.updateProfile("q", { pendingRemove: false, gameId: "skyrimse" });
      await f.restart();
      expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
        General: { owner: "global", tweak: "0", SLocalSavePath: "Saves" + path.sep },
      });
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
      expect(f.errors()).toEqual([]);
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("clears recovery selection when deployment cancels the profile switch", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false, "test[skyrim].ini", true);
  try {
    f.setSaves(true);
    f.obstruct(".base");
    f.edit("p", true);
    await f.drain();
    f.setDeploy((callback) => callback(new errors.ProcessCanceled("deployment canceled")));
    f.queueSwitch("q");
    await f.drain();
    expect(f.state().settings.profiles.activeProfileId).toBeUndefined();
    expect(f.state().settings.profiles.lastActiveProfile.skyrimse).toBe("p");
    await f.repair();
    f.activate();
    await f.drain();
    expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
      General: { owner: "private", tweak: "1", SLocalSavePath: path.join("Saves", "p") + path.sep },
    });
    const journal = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
    expect(journal.pending).toBeUndefined();
    expect(journal.installed.skyrimse.id).toBe("p");
  } finally {
    f.setDeploy(undefined);
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

const confirmationCases = [false, true].flatMap((failedP) =>
  [false, true].map((privateQ) => ({ failedP, privateQ })),
);

async function unconfirmedSettings(
  f: Awaited<ReturnType<typeof recoveryFixture>>,
  failedP: boolean,
  privateQ: boolean,
  competing?: string,
  privateP = true,
) {
  f.setSaves(true);
  f.updateProfile("q", {
    features: { local_game_settings: privateQ, local_saves: true },
    modState: { tweak: { enabled: false, enabledTime: 1 } },
  });
  const q = f.profileDirectory("q");
  await fs.mkdir(q, { recursive: true });
  for (const file of f.files)
    await fs.writeFile(path.join(q, file), "[General]\nowner=q\ntweak=0\n");
  if (failedP) f.obstruct(".base");
  if (privateP) f.edit("p", true);
  await f.drain();
  let finish: (error: Error | null) => void = () => {};
  let entered: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setDeploy((callback, profileId) => {
    expect(profileId).toBe("q");
    finish = (error) => {
      finish = () => {};
      callback(error);
    };
    entered();
  });
  f.queueSwitch("q");
  await ready;
  let diskSnapshot: Array<[string, Buffer]>;
  try {
    if (failedP) {
      await f.repair();
      expect(await f.bakeProfile("q")).toEqual([{ settingsBaked: true }]);
    }
    expect(f.state().settings.profiles.activeProfileId).toBe("p");
    expect(f.state().settings.profiles.nextProfileId).toBe("q");
    expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
      General: {
        owner: privateQ ? "q" : "global",
        tweak: "0",
        SLocalSavePath: path.join("Saves", "q") + path.sep,
      },
    });
    const journal = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
    expect(journal.installed.skyrimse.id).toBe("q");
    const snapshotFiles = [
      f.recoveryFile,
      ...f.files.flatMap((file) => [
        ...["", ".base", ".baked"].map((suffix) => path.join(f.game, file + suffix)),
        path.join(f.saved, file),
        path.join(q, file),
        path.join(f.backup, file),
      ]),
    ];
    diskSnapshot = await Promise.all(
      snapshotFiles.map(async (file) => [file, await fs.readFile(file)] as [string, Buffer]),
    );
    if (competing !== undefined) f.queueSwitch(competing);
    const persisted = await f.persistState();
    expect(persisted.settings.profiles.activeProfileId).toBe("p");
    expect(persisted.settings.profiles.nextProfileId).toBe(competing ?? "q");
    expect(persisted.persistent.profiles.p.features.local_game_settings).toBe(privateP);
    return persisted;
  } finally {
    // Settle the old run after saving the exact pre-confirmation database state.
    if (competing !== undefined) f.queueSwitch("q");
    f.setDeploy(undefined);
    finish(null);
    await f.drain();
    for (const [file, bytes] of diskSnapshot ?? []) expect(await fs.readFile(file)).toEqual(bytes);
  }
}

async function expectConfirmedP(f: Awaited<ReturnType<typeof recoveryFixture>>) {
  expect(f.state().settings.profiles.activeProfileId).toBe("p");
  expect(f.state().settings.profiles.nextProfileId).toBe("p");
  expect.soft((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
    General: { owner: "private", tweak: "1", SLocalSavePath: path.join("Saves", "p") + path.sep },
  });
  for (const file of f.files) {
    for (const suffix of ["", ".base", ".baked"])
      expect(((await f.values(path.join(f.game, file + suffix))) as any).General.owner).toBe(
        "private",
      );
    expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("private");
    expect(((await f.values(path.join(f.profileDirectory("q"), file))) as any).General.owner).toBe(
      "q",
    );
    expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
  }
  expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
    General: { owner: "private", tweak: "1", SLocalSavePath: path.join("Saves", "p") + path.sep },
  });
  const journal = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
  expect(journal.pending).toBeUndefined();
  expect(journal.installed.skyrimse.id).toBe("p");
}

test.each(confirmationCases)(
  "restores confirmed P from native persistence before Q confirmation: failed P=$failedP, private Q=$privateQ",
  async ({ failedP, privateQ }) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false, "test[skyrim].ini", true);
    try {
      const persisted = await unconfirmedSettings(f, failedP, privateQ);
      await f.restart(persisted);
      await expectConfirmedP(f);
      await f.switchTo("q");
      expect(((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.owner).toBe(
        privateQ ? "q" : "global",
      );
      await f.switchTo("p");
      await expectConfirmedP(f);
      expect(f.errors()).toEqual([]);
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each(
  ["activation", "restart"].flatMap((retry) =>
    ["journal", "snapshot", "global-install", "private-install", "bake"].map((failure) => ({
      retry,
      failure,
    })),
  ),
)("retries interrupted confirmation rollback: $failure, $retry", async ({ failure, retry }) => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false, "test[skyrim].ini", true);
  let blocked = false;
  let hits = 0;
  let installingP = false;
  try {
    const persisted = await unconfirmedSettings(f, true, true);
    const before = await fs.readFile(f.recoveryFile, "utf8");
    if (failure === "journal") {
      await fs.mkdir(f.recoveryFile + ".tmp");
      blocked = true;
    }
    f.setCopy(async (source, destination, copy) => {
      if (source === path.join(f.saved, "SkyrimPrefs.ini")) installingP = true;
      if (
        (failure === "snapshot" &&
          destination === path.join(f.profileDirectory("q"), "SkyrimPrefs.ini")) ||
        (failure === "global-install" && source === path.join(f.backup, "SkyrimPrefs.ini")) ||
        (failure === "private-install" && source === path.join(f.saved, "SkyrimPrefs.ini")) ||
        (failure === "bake" && installingP && source === path.join(f.game, "SkyrimPrefs.ini.baked"))
      ) {
        ++hits;
        throw Object.assign(new Error("rollback copy blocked"), { code: "EACCES" });
      }
      await copy();
    });
    await f.restart(persisted);
    expect(f.state().settings.profiles.activeProfileId).toBe("p");
    const interrupted = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
    if (failure === "journal") expect(await fs.readFile(f.recoveryFile, "utf8")).toBe(before);
    else {
      expect(hits).toBeGreaterThan(0);
      expect(interrupted.pending.oldProfile.id).toBe("q");
      expect(interrupted.pending.newProfile.id).toBe("p");
    }
    const operation = vi.fn(() => Bluebird.resolve());
    await expect(f.queueOperation(operation)).rejects.toThrow(
      "Game settings recovery is incomplete",
    );
    expect(operation).not.toHaveBeenCalled();
    for (const file of f.files) {
      expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("private");
      expect(
        ((await f.values(path.join(f.profileDirectory("q"), file))) as any).General.owner,
      ).toBe("q");
      expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
    }
    f.setCopy(undefined);
    if (blocked) {
      await fs.rmdir(f.recoveryFile + ".tmp");
      blocked = false;
    }
    if (retry === "restart") await f.restart(await f.persistState());
    else {
      f.activate();
      await f.drain();
    }
    await expectConfirmedP(f);
    await f.switchTo("q");
    expect(((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.owner).toBe("q");
    await f.switchTo("p");
    await expectConfirmedP(f);
  } finally {
    f.setCopy(undefined);
    if (blocked) await fs.rmdir(f.recoveryFile + ".tmp");
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each(
  [false, true].flatMap((failedP) =>
    ["p", "g", "other"].map((competing) => ({ failedP, competing })),
  ),
)(
  "startup keeps confirmed P over competing next $competing, failed P=$failedP",
  async ({ failedP, competing }) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false, "test[skyrim].ini", true);
    try {
      const persisted = await unconfirmedSettings(f, failedP, true, competing);
      await f.restart(persisted);
      await expectConfirmedP(f);
      expect(f.errors()).toEqual([]);
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each(confirmationCases)(
  "native startup retains confirmed Q, failed P=$failedP, private Q=$privateQ",
  async ({ failedP, privateQ }) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false, "test[skyrim].ini", true);
    try {
      await unconfirmedSettings(f, failedP, privateQ);
      await f.restart(await f.persistState());
      expect(f.state().settings.profiles.activeProfileId).toBe("q");
      expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
        General: {
          owner: privateQ ? "q" : "global",
          tweak: "0",
          SLocalSavePath: path.join("Saves", "q") + path.sep,
        },
      });
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
      expect(f.errors()).toEqual([]);
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each([false, true])(
  "restores global confirmed P before Q confirmation, private Q=%s",
  async (privateQ) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false, "test[skyrim].ini", true);
    try {
      const persisted = await unconfirmedSettings(f, false, privateQ, undefined, false);
      await f.restart(persisted);
      expect(f.state().settings.profiles.activeProfileId).toBe("p");
      expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
        General: {
          owner: "global",
          tweak: "1",
          SLocalSavePath: path.join("Saves", "p") + path.sep,
        },
      });
      for (const file of f.files) {
        expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("private");
        expect(
          ((await f.values(path.join(f.profileDirectory("q"), file))) as any).General.owner,
        ).toBe("q");
        expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
      }
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
      expect(f.errors()).toEqual([]);
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each([false, true])(
  "retains unconfirmed Q live edits under their owner, private Q=%s",
  async (privateQ) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false, "test[skyrim].ini", true);
    try {
      const persisted = await unconfirmedSettings(f, false, privateQ);
      for (const file of f.files) await fs.appendFile(path.join(f.game, file), "\nmanual=q-live\n");
      await f.restart(persisted);
      await expectConfirmedP(f);
      for (const file of f.files) {
        expect(((await f.values(path.join(f.saved, file))) as any).General.manual).toBeUndefined();
        expect(
          ((await f.values(path.join(f.profileDirectory("q"), file))) as any).General.manual,
        ).toBe(privateQ ? "q-live" : undefined);
        expect(((await f.values(path.join(f.backup, file))) as any).General.manual).toBe(
          privateQ ? undefined : "q-live",
        );
      }
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("normal switching bakes P live edits before installing Q", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false, "test[skyrim].ini", true);
  try {
    f.setSaves(true);
    f.edit("p", true);
    await f.drain();
    for (const file of f.files) await fs.appendFile(path.join(f.game, file), "\nmanual=p-live\n");
    const persisted = await unconfirmedSettings(f, false, true);
    for (const file of f.files) {
      expect(((await f.values(path.join(f.saved, file))) as any).General.manual).toBe("p-live");
      expect(
        ((await f.values(path.join(f.profileDirectory("q"), file))) as any).General.manual,
      ).toBeUndefined();
      expect(((await f.values(path.join(f.backup, file))) as any).General.manual).toBeUndefined();
    }
    await f.restart(persisted);
    expect((await f.values(path.join(f.game, "Skyrim.ini"))) as any).toEqual({
      General: {
        owner: "private",
        tweak: "1",
        manual: "p-live",
        SLocalSavePath: path.join("Saves", "p") + path.sep,
      },
    });
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

const bakePreparationCases = ["tweak-file", "tweak-directory", "write"].flatMap((failure) =>
  ["retry", "restart", "disable", "purge"].map((retry) => ({ failure, retry })),
);

test.each(bakePreparationCases)(
  "preserves the last valid bake after $failure failure and recovers through $retry",
  async ({ failure, retry }) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false);
    const tweaks = path.join(f.root, "mods", "tweak", "INI Tweaks");
    const tweak = path.join(tweaks, "test[skyrim].ini");
    let blocked = false;
    try {
      await f.deploymentBake();
      const snapshots = await Promise.all(
        f.files.flatMap((file) =>
          ["", ".base", ".baked"].map(async (suffix) => {
            const filename = path.join(f.game, file + suffix);
            return [filename, await fs.readFile(filename)] as const;
          }),
        ),
      );
      blocked = true;
      if (failure.startsWith("tweak-"))
        await fs.chmod(failure === "tweak-file" ? tweak : tweaks, 0o000);
      f.onApply((_profile, file, ini) => {
        if (!blocked || file !== path.join(f.game, "Skyrim.ini")) return;
        if (failure === "write") ini.data.General.tweak = "invalid\nvalue";
      });
      for (let attempt = 0; attempt < 2; ++attempt) {
        await f.deploymentBake();
        expect.soft(f.errors().at(-1)?.title).toBe("Failed to bake settings files");
        for (const [filename, bytes] of snapshots)
          expect.soft(await fs.readFile(filename), filename).toEqual(bytes);
      }
      blocked = false;
      await fs.chmod(tweaks, 0o700);
      await fs.chmod(tweak, 0o600);
      if (retry === "restart") await f.restart(await f.persistState());
      if (retry === "disable" || retry === "purge") f.enableTweak(false);
      if (retry === "purge") {
        f.purge();
        await f.drain();
      } else if (retry === "disable")
        expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
      else await f.deploymentBake();
      for (const file of f.files) {
        const expected = {
          General: {
            owner: "global",
            tweak: file === "Skyrim.ini" && !["disable", "purge"].includes(retry) ? "1" : "0",
          },
        };
        for (const suffix of ["", ".baked"])
          expect.soft(await f.values(path.join(f.game, file + suffix))).toEqual(expected);
        expect.soft(await f.values(path.join(f.game, file + ".base"))).toEqual({
          General: { owner: "global", tweak: "0" },
        });
      }
      expect((await fs.readdir(f.game)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
    } finally {
      blocked = false;
      await fs.chmod(tweaks, 0o700);
      await fs.chmod(tweak, 0o600);
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("a successful bake retains manual edits and allows a mod without tweaks", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  try {
    await f.deploymentBake();
    await fs.appendFile(path.join(f.game, "Skyrim.ini"), "manual=kept\n");
    await f.deploymentBake();
    expect(await f.values(path.join(f.game, "Skyrim.ini.base"))).toEqual({
      General: { owner: "global", tweak: "0", manual: "kept" },
    });
    await fs.rm(path.join(f.root, "mods", "tweak", "INI Tweaks"), { recursive: true });
    await f.deploymentBake();
    for (const suffix of ["", ".base", ".baked"])
      expect(await f.values(path.join(f.game, "Skyrim.ini" + suffix))).toEqual({
        General: { owner: "global", tweak: "0", manual: "kept" },
      });
    expect(f.errors()).toEqual([]);
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

async function expectReversedFeature(
  f: Awaited<ReturnType<typeof recoveryFixture>>,
  wasPrivate: boolean,
  privateOwner = wasPrivate ? "latest" : "private",
) {
  const owner = wasPrivate ? "latest" : "global";
  for (const file of f.files) {
    const general = { owner, tweak: "0" };
    expect.soft(await f.values(path.join(f.game, file + ".base"))).toEqual({ General: general });
    for (const suffix of ["", ".baked"])
      expect.soft(await f.values(path.join(f.game, file + suffix))).toEqual({
        General: {
          ...general,
          ...(file === "Skyrim.ini"
            ? { tweak: "1", SLocalSavePath: path.join("Saves", "p") + path.sep }
            : {}),
        },
      });
    expect.soft(await f.values(path.join(f.saved, file))).toEqual({
      General: { owner: privateOwner, tweak: "0" },
    });
    expect.soft(await f.values(path.join(f.backup, file))).toEqual({
      General: { owner: "global", tweak: "0" },
    });
  }
}

const reversedFeatureCases = [false, true].flatMap((wasPrivate) =>
  ["copy", "bake"].flatMap((failure) =>
    ["activation", "restart", "other-profile-edit"].map((retry) => ({
      wasPrivate,
      failure,
      retry,
    })),
  ),
);

test.each(reversedFeatureCases)(
  "reconciles a reversed settings feature: private=$wasPrivate, $failure, $retry",
  async ({ wasPrivate, failure, retry }) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(wasPrivate, "test[skyrim].ini", true);
    let blocked = true;
    try {
      f.setSaves(true);
      if (failure === "copy") f.obstruct(".base");
      f.onApply((_profile, file, ini) => {
        if (
          failure === "bake" &&
          blocked &&
          file === path.join(f.game, "Skyrim.ini") &&
          ini.data.General.owner === (wasPrivate ? "global" : "private")
        )
          ini.data.General.tweak = "invalid\nvalue";
      });
      f.edit("p", !wasPrivate);
      await f.drain();
      const interrupted = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
      expect(interrupted.pending.newProfile.features.local_game_settings).toBe(!wasPrivate);
      f.edit("p", wasPrivate);
      await f.drain();
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8"))).toEqual(interrupted);
      await expect(f.queueOperation(() => Bluebird.resolve())).rejects.toThrow(
        "Game settings recovery is incomplete",
      );
      blocked = false;
      if (failure === "copy") await f.repair();
      if (retry === "restart") await f.restart(await f.persistState());
      else if (retry === "other-profile-edit") f.edit("q", true);
      else f.activate();
      await f.drain();
      await expectReversedFeature(f, wasPrivate);
      const recovered = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
      expect.soft(recovered.pending).toBeUndefined();
      expect.soft(recovered.installed.skyrimse.features.local_game_settings).toBe(wasPrivate);
      expect(f.state().persistent.profiles.p.features.local_game_settings).toBe(wasPrivate);
      expect(f.state().settings.profiles.activeProfileId).toBe("p");
      await f.restart(await f.persistState());
      expect(await fs.readFile(f.recoveryFile, "utf8")).toBe(JSON.stringify(recovered));
      expect
        .soft(((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.owner)
        .toBe(wasPrivate ? "latest" : "global");
    } finally {
      blocked = false;
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each([false, true])(
  "a successful feature reversal preserves ownership: private=%s",
  async (wasPrivate) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(wasPrivate, "test[skyrim].ini", true);
    try {
      f.setSaves(true);
      f.edit("p", !wasPrivate);
      await f.drain();
      expect(
        JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).installed.skyrimse.features
          .local_game_settings,
      ).toBe(!wasPrivate);
      f.edit("p", wasPrivate);
      await f.drain();
      await f.restart(await f.persistState());
      await expectReversedFeature(f, wasPrivate);
      expect(f.errors()).toEqual([]);
      expect(f.showError).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each(
  [false, true].flatMap((wasPrivate) =>
    ["copy", "bake"].map((failure) => ({ wasPrivate, failure })),
  ),
)(
  "retries a failed reversed-feature handoff after restart: private=$wasPrivate, $failure",
  async ({ wasPrivate, failure }) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(wasPrivate, "test[skyrim].ini", true);
    let blocked = true;
    let hits = 0;
    try {
      f.setSaves(true);
      f.obstruct(".base");
      f.edit("p", !wasPrivate);
      await f.drain();
      f.edit("p", wasPrivate);
      await f.drain();
      await f.repair();
      const rollbackSource = path.join(wasPrivate ? f.saved : f.backup, "SkyrimPrefs.ini");
      f.setCopy(async (source, destination, copy) => {
        if (
          blocked &&
          failure === "copy" &&
          source === rollbackSource &&
          destination === path.join(f.game, "SkyrimPrefs.ini.base")
        ) {
          ++hits;
          throw Object.assign(new Error("handoff copy blocked"), { code: "EACCES" });
        }
        await copy();
      });
      f.onApply((_profile, file, ini) => {
        if (
          blocked &&
          failure === "bake" &&
          file === path.join(f.game, "Skyrim.ini") &&
          ini.data.General.owner === (wasPrivate ? "latest" : "global")
        ) {
          ++hits;
          ini.data.General.tweak = "invalid\nvalue";
        }
      });
      f.activate();
      await f.drain();
      expect(hits).toBeGreaterThan(0);
      const interrupted = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
      expect(interrupted.pending.newProfile.features.local_game_settings).toBe(wasPrivate);
      expect(interrupted.pending.oldProfile.features.local_game_settings).toBe(!wasPrivate);
      await expect(f.queueOperation(() => Bluebird.resolve())).rejects.toThrow(
        "Game settings recovery is incomplete",
      );
      blocked = false;
      f.setCopy(undefined);
      await f.restart(await f.persistState());
      await expectReversedFeature(f, wasPrivate);
      const recovered = await fs.readFile(f.recoveryFile, "utf8");
      expect(JSON.parse(recovered).pending).toBeUndefined();
      f.activate();
      await f.drain();
      expect(await fs.readFile(f.recoveryFile, "utf8")).toBe(recovered);
      await expectReversedFeature(f, wasPrivate);
    } finally {
      blocked = false;
      f.setCopy(undefined);
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each([false, true])(
  "queued feature edits use the current choice: private=%s",
  async (wasPrivate) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(wasPrivate, "test[skyrim].ini", true);
    try {
      f.setSaves(true);
      f.edit("p", !wasPrivate);
      f.edit("p", wasPrivate);
      f.edit("q", true);
      await f.drain();
      await f.deploymentBake();
      await expectReversedFeature(f, wasPrivate, "private");
      expect(
        JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).installed.skyrimse.features
          .local_game_settings,
      ).toBe(wasPrivate);
      expect(f.errors()).toEqual([]);
      expect(f.showError).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

const finalCopyCases = ["Skyrim.ini", "SkyrimPrefs.ini"].flatMap((failedFile) =>
  ["denied", "removed", "partial"].flatMap((failure) =>
    ["retry", "restart", "disable", "purge"].map((retry) => ({ failedFile, failure, retry })),
  ),
);

test.each(finalCopyCases)(
  "recovers final live copy failure without importing tweaks: $failedFile, $failure, $retry",
  async ({ failedFile, failure, retry }) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false);
    const tweaks = path.join(f.root, "mods", "tweak", "INI Tweaks");
    const failed = path.join(f.game, failedFile);
    let blocked = false;
    let failures = 0;
    try {
      await fs.writeFile(path.join(tweaks, "SkyrimPrefs.ini"), "[General]\ntweak=1\n");
      await f.deploymentBake();
      for (const file of f.files.slice(0, 2))
        await fs.appendFile(path.join(f.game, file), "manual=kept\n");
      for (const tweak of ["test[skyrim].ini", "SkyrimPrefs.ini"])
        await fs.writeFile(path.join(tweaks, tweak), "[General]\ntweak=2\n");
      f.setCopy(async (source, destination, copy) => {
        if (!blocked || source !== failed + ".baked" || !destination.endsWith(".live.tmp"))
          return copy();
        ++failures;
        if (failure === "partial") {
          await fs.writeFile(destination, "[General]\ntweak=2\n");
          throw Object.assign(new Error("live copy ran out of space"), { code: "ENOSPC" });
        }
        const deniedPath = failure === "removed" ? source : f.game;
        await fs.chmod(deniedPath, failure === "removed" ? 0o000 : 0o500);
        try {
          return await copyProgramFile(source, destination, { noSelfCopy: true });
        } catch (error) {
          if (failure === "removed")
            await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
          throw error;
        } finally {
          await fs.chmod(deniedPath, failure === "removed" ? 0o600 : 0o700);
        }
      });
      blocked = true;
      for (let attempt = 0; attempt < 2; ++attempt) {
        await f.deploymentBake();
        expect.soft(f.errors().at(-1)).toMatchObject({
          title: "Failed to bake settings files",
          message: { code: failure === "partial" ? "ENOSPC" : "EACCES" },
        });
        expect.soft(await f.values(failed + ".base")).toEqual({
          General: { owner: "global", tweak: "0", manual: "kept" },
        });
      }
      expect(failures).toBe(2);
      blocked = false;
      if (retry === "restart") await f.restart(await f.persistState());
      if (retry === "retry" || retry === "restart") await f.deploymentBake();
      if (retry === "purge") {
        f.purge();
        await f.drain();
      } else {
        f.enableTweak(false);
        expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
      }
      for (const file of f.files) {
        const expected = {
          General: {
            owner: "global",
            tweak: "0",
            ...(file !== "SkyrimCustom.ini" ? { manual: "kept" } : {}),
          },
        };
        for (const suffix of ["", ".base", ".baked"])
          expect.soft(await f.values(path.join(f.game, file + suffix))).toEqual(expected);
      }
      expect((await fs.readdir(f.game)).filter((file) => /\.(tmp|pending)$/.test(file))).toEqual(
        [],
      );
    } finally {
      blocked = false;
      await fs.chmod(f.game, 0o700);
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("successful multi-file deployment removes tweaks without contaminating base", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  try {
    await fs.writeFile(
      path.join(f.root, "mods", "tweak", "INI Tweaks", "SkyrimPrefs.ini"),
      "[General]\ntweak=1\n",
    );
    await f.deploymentBake();
    await f.restart(await f.persistState());
    expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
    for (const file of f.files)
      for (const suffix of ["", ".base", ".baked"])
        expect(await f.values(path.join(f.game, file + suffix))).toEqual({
          General: { owner: "global", tweak: "0" },
        });
    expect(f.errors()).toEqual([]);
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each(["journal-write", "journal-rename", "baked-rename", "journal-unlink", "cancel-copy"])(
  "rolls back a failed bake publication phase: %s",
  async (phase) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false);
    const file = path.join(f.game, "Skyrim.ini");
    const journal = file + ".baked.pending";
    let armed = true;
    const fail = () => {
      armed = false;
      throw Object.assign(new Error("publication blocked"), { code: "EACCES" });
    };
    try {
      await f.deploymentBake();
      const snapshots = await Promise.all(
        f.files.flatMap((name) =>
          ["", ".base", ".baked"].map(async (suffix) => {
            const filename = path.join(f.game, name + suffix);
            return [filename, await fs.readFile(filename), (await fs.stat(filename)).mode] as const;
          }),
        ),
      );
      f.setFileOperation("writeFileAsync", (destination, ...args) => {
        if (armed && phase === "journal-write" && destination.startsWith(journal)) fail();
        return (fs.writeFile as any)(destination, ...args);
      });
      f.setFileOperation("renameAsync", (source, destination) => {
        if (
          armed &&
          ((phase === "journal-rename" && destination === journal) ||
            (phase === "baked-rename" && destination === file + ".baked"))
        )
          fail();
        return fs.rename(source, destination);
      });
      f.setFileOperation("unlinkAsync", (destination) => {
        if (armed && phase === "journal-unlink" && destination === journal) fail();
        return fs.unlink(destination);
      });
      f.setCopy((source, destination, copy) => {
        if (
          armed &&
          phase === "cancel-copy" &&
          source === file + ".baked" &&
          destination.endsWith(".live.tmp")
        ) {
          armed = false;
          throw new errors.UserCanceled();
        }
        return copy();
      });
      const [result] = (await f.bakeResult()) as any[];
      expect(result.settingsBaked).toBe(false);
      if (phase === "cancel-copy") expect(result.error).toBeInstanceOf(errors.UserCanceled);
      else expect(result.error).toMatchObject({ code: "EACCES" });
      expect(armed).toBe(false);
      for (const [filename, bytes, mode] of snapshots) {
        expect(await fs.readFile(filename)).toEqual(bytes);
        expect((await fs.stat(filename)).mode).toBe(mode);
      }
      expect((await fs.readdir(f.game)).filter((name) => /\.(tmp|pending)$/.test(name))).toEqual(
        [],
      );
      expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
      expect(await f.values(file)).toEqual({ General: { owner: "global", tweak: "0" } });
    } finally {
      armed = false;
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each(
  ["live", "baked", "journal"].flatMap((failure) =>
    ["retry", "restart", "activation", "purge"].map((retry) => ({ failure, retry })),
  ),
)(
  "retains a failed bake rollback and recovers before discovery: $failure, $retry",
  async ({ failure, retry }) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false);
    const file = path.join(f.game, "Skyrim.ini");
    const journal = file + ".baked.pending";
    let blocked = true;
    let failCopy = true;
    try {
      await f.deploymentBake();
      const original = await fs.readFile(file);
      const originalBaked = await fs.readFile(file + ".baked");
      f.setFileOperation("renameAsync", (source, destination) => {
        if (
          blocked &&
          !failCopy &&
          failure !== "journal" &&
          destination === (failure === "live" ? file : file + ".baked")
        )
          throw Object.assign(new Error("rollback rename blocked"), { code: "EACCES" });
        return fs.rename(source, destination);
      });
      f.setFileOperation("unlinkAsync", (destination) => {
        if (failCopy && destination === journal) {
          failCopy = false;
          throw Object.assign(new Error("journal removal interrupted"), { code: "EIO" });
        }
        if (blocked && !failCopy && failure === "journal" && destination === journal)
          throw Object.assign(new Error("rollback journal blocked"), { code: "EACCES" });
        return fs.unlink(destination);
      });

      const [result] = (await f.bakeResult()) as any[];
      expect(result.settingsBaked).toBe(false);
      expect(result.error).toBeInstanceOf(AggregateError);
      expect(result.error.errors.map((error) => error.code)).toEqual(["EIO", "EACCES"]);
      expect((await fs.stat(journal)).mode & 0o777).toBe(0o600);
      const base = await fs.readFile(file + ".base");
      if (retry === "restart") await f.restart(await f.persistState());
      if (retry === "activation") {
        f.activate();
        await f.drain();
        expect(f.errors().at(-1)?.title).toBe("Failed to recover game settings");
      } else if (retry === "purge") {
        f.purge();
        await f.drain();
        expect(f.errors().at(-1)?.title).toBe("Failed to purge ini edits");
      } else {
        expect(await f.bakeResult()).toMatchObject([{ settingsBaked: false }]);
      }
      expect(await fs.readFile(file + ".base")).toEqual(base);
      expect(await fs.stat(journal)).toBeDefined();
      blocked = false;
      if (retry === "activation") {
        f.activate();
        await f.drain();
        expect(await fs.readFile(file)).toEqual(original);
        expect(await fs.readFile(file + ".baked")).toEqual(originalBaked);
      }
      expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
      for (const suffix of ["", ".base", ".baked"])
        expect(await f.values(file + suffix)).toEqual({ General: { owner: "global", tweak: "0" } });
      await expect(fs.stat(journal)).rejects.toMatchObject({ code: "ENOENT" });
      await f.restart(await f.persistState());
      expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
      expect((await fs.readdir(f.game)).filter((name) => /\.(tmp|pending)$/.test(name))).toEqual(
        [],
      );
    } finally {
      blocked = false;
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each(["unreadable", "invalid-json", "invalid-snapshot"])(
  "blocks discovery with %s bake recovery data and retries after repair",
  async (failure) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false);
    const file = path.join(f.game, "Skyrim.ini");
    const journal = file + ".baked.pending";
    try {
      await f.deploymentBake();
      const live = await fs.readFile(file);
      const base = await fs.readFile(file + ".base");
      const baked = await fs.readFile(file + ".baked");
      await fs.writeFile(
        journal,
        failure === "invalid-json"
          ? "{"
          : JSON.stringify({
              version: 1,
              live: { content: live.toString("base64"), mode: 0o600 },
              baked: {
                content: failure === "invalid-snapshot" ? "!" : baked.toString("base64"),
                mode: 0o600,
              },
            }),
      );
      if (failure === "unreadable") await fs.chmod(journal, 0o000);
      await fs.writeFile(file, "[General]\ntweak=0\n");
      await f.restart(await f.persistState());
      expect(await f.bakeResult()).toMatchObject([{ settingsBaked: false }]);
      expect(await fs.readFile(file + ".base")).toEqual(base);
      expect(await fs.readFile(file + ".baked")).toEqual(baked);
      await fs.chmod(journal, 0o600);
      await fs.writeFile(
        journal,
        JSON.stringify({
          version: 1,
          candidate: {
            content: Buffer.from("[General]\ntweak=0\n").toString("base64"),
            mode: 0o600,
          },
          live: { content: live.toString("base64"), mode: 0o600 },
          baked: { content: baked.toString("base64"), mode: 0o600 },
        }),
      );
      expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
      expect(await f.values(file + ".base")).toEqual({ General: { owner: "global", tweak: "0" } });
      expect(await f.values(file)).toEqual({ General: { owner: "global", tweak: "0" } });
    } finally {
      await fs.chmod(journal, 0o600).catch(() => {});
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("native filesystem denial retains rollback across restart and permits later settings swaps", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  const file = path.join(f.game, "Skyrim.ini");
  const journal = file + ".baked.pending";
  let blocked = true;
  try {
    await f.deploymentBake();
    const base = await fs.readFile(file + ".base");
    const live = await fs.readFile(file);
    f.setCopy(async (source, destination, copy) => {
      if (source !== file + ".baked" || !destination.endsWith(".live.tmp")) return copy();
      if (blocked) await fs.chmod(f.game, 0o500);
      return copyProgramFile(source, destination, { noSelfCopy: true });
    });
    const [result] = (await f.bakeResult()) as any[];
    expect(result.settingsBaked).toBe(false);
    expect(result.error).toBeInstanceOf(AggregateError);
    expect(result.error.errors.map((error) => error.code)).toEqual(["EACCES", "EACCES"]);
    expect(await fs.readFile(file)).toEqual(live);
    expect(await fs.readFile(file + ".base")).toEqual(base);
    expect(await fs.stat(journal)).toBeDefined();
    await f.restart(await f.persistState());
    expect(await f.bakeResult()).toMatchObject([
      { settingsBaked: false, error: { code: "EACCES" } },
    ]);
    expect(await fs.readFile(file + ".base")).toEqual(base);
    blocked = false;
    await fs.chmod(f.game, 0o700);
    f.activate();
    await f.drain();
    expect(await fs.readFile(file)).toEqual(live);
    expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
    f.enableTweak(false);
    f.edit("p", true);
    await f.drain();
    for (const name of f.files)
      expect(await f.values(path.join(f.game, name + ".base"))).toEqual({
        General: { owner: "private", tweak: "0" },
      });
    f.edit("p", false);
    await f.drain();
    for (const name of f.files)
      for (const suffix of ["", ".base", ".baked"])
        expect(await f.values(path.join(f.game, name + suffix))).toEqual({
          General: { owner: "global", tweak: "0" },
        });
    expect((await fs.readdir(f.game)).filter((name) => /\.(tmp|pending)$/.test(name))).toEqual([]);
  } finally {
    blocked = false;
    await fs.chmod(f.game, 0o700);
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test("retries a final copy failure while creating a missing optional INI", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  const file = path.join(f.game, "SkyrimCustom.ini");
  let blocked = true;
  try {
    for (const suffix of ["", ".base", ".baked"]) await fs.unlink(file + suffix);
    await fs.writeFile(
      path.join(f.root, "mods", "tweak", "INI Tweaks", "SkyrimCustom.ini"),
      "[General]\noptional=mod\n",
    );
    f.setCopy(async (source, destination, copy) => {
      if (!blocked || source !== file + ".baked" || !destination.endsWith(".live.tmp"))
        return copy();
      await fs.chmod(f.game, 0o500);
      try {
        return await copy();
      } finally {
        await fs.chmod(f.game, 0o700);
      }
    });
    await f.deploymentBake();
    expect(f.errors().at(-1)).toMatchObject({ message: { code: "EACCES" } });
    blocked = false;
    await f.restart(await f.persistState());
    await f.deploymentBake();
    expect(await f.values(file)).toEqual({ General: { optional: "mod" } });
    expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
    expect(await f.values(file + ".base")).toEqual({});
    expect(await f.values(file)).toEqual({});
    expect((await fs.readdir(f.game)).filter((name) => /\.(tmp|pending)$/.test(name))).toEqual([]);
  } finally {
    blocked = false;
    await fs.chmod(f.game, 0o700);
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each(["restart", "restored-reference"])(
  "a single final copy failure recovers through %s before any second bake",
  async (retry) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false);
    const file = path.join(f.game, "Skyrim.ini");
    let blocked = true;
    try {
      await f.deploymentBake();
      const baked = await fs.readFile(file + ".baked");
      await fs.writeFile(
        path.join(f.root, "mods", "tweak", "INI Tweaks", "test[skyrim].ini"),
        "[General]\ntweak=2\n",
      );
      f.setCopy(async (source, destination, copy) => {
        if (!blocked || source !== file + ".baked" || !destination.endsWith(".live.tmp"))
          return copy();
        await fs.chmod(f.game, 0o500);
        try {
          return await copyProgramFile(source, destination, { noSelfCopy: true });
        } finally {
          await fs.chmod(f.game, 0o700);
        }
      });
      await f.deploymentBake();
      expect(f.errors().at(-1)).toMatchObject({ message: { code: "EACCES" } });
      blocked = false;
      await fs.appendFile(file, "afterFailure=kept\n");
      if (retry === "restart") await f.restart(await f.persistState());
      else await fs.writeFile(file + ".baked", baked);
      expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
      for (const suffix of ["", ".base", ".baked"])
        expect.soft(await f.values(file + suffix)).toEqual({
          General: { owner: "global", tweak: "0", afterFailure: "kept" },
        });
    } finally {
      blocked = false;
      await fs.chmod(f.game, 0o700);
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("pending bake rollback retains later external edits until explicitly reconciled", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  const file = path.join(f.game, "Skyrim.ini");
  const journal = file + ".baked.pending";
  let blocked = true;
  let failCopy = true;
  try {
    await f.deploymentBake();
    const original = await fs.readFile(file);
    const base = await fs.readFile(file + ".base");
    f.setFileOperation("renameAsync", (source, destination) => {
      if (blocked && !failCopy && destination === file)
        throw Object.assign(new Error("rollback blocked"), { code: "EACCES" });
      return fs.rename(source, destination);
    });
    f.setFileOperation("unlinkAsync", (destination) => {
      if (failCopy && destination === journal) {
        failCopy = false;
        throw Object.assign(new Error("journal removal interrupted"), { code: "EIO" });
      }
      return fs.unlink(destination);
    });
    expect(await f.bakeResult()).toMatchObject([{ settingsBaked: false }]);
    blocked = false;
    await fs.appendFile(file, "external=kept\n");
    const edited = await fs.readFile(file);
    const record = await fs.readFile(journal);
    await f.restart(await f.persistState());
    const [result] = (await f.bakeResult()) as any[];
    expect(result.settingsBaked).toBe(false);
    expect(result.error.message).toContain("INI changed while bake recovery was pending");
    expect(await fs.readFile(file)).toEqual(edited);
    expect(await fs.readFile(file + ".base")).toEqual(base);
    expect(await fs.readFile(journal)).toEqual(record);
    // Reconciliation retains the edit with the original live values.
    await fs.writeFile(file, Buffer.concat([original, Buffer.from("external=kept\n")]));
    const saved = JSON.parse(record.toString().split("\n")[0]);
    // The record preserves the reconciled live bytes for the normal discovery step.
    saved.live.content = (await fs.readFile(file)).toString("base64");
    await fs.writeFile(journal, JSON.stringify(saved) + "\n");
    expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
    for (const suffix of ["", ".base", ".baked"])
      expect(await f.values(file + suffix)).toEqual({
        General: { owner: "global", tweak: "0", external: "kept" },
      });
  } finally {
    blocked = false;
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each(["retry", "restart", "purge"])(
  "failed final purge copy keeps tweaks out of base on %s",
  async (retry) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false);
    const file = path.join(f.game, "Skyrim.ini");
    let blocked = true;
    let failures = 0;
    try {
      await f.deploymentBake();
      f.setCopy(async (source, destination, copy) => {
        if (!blocked || source !== file + ".base" || !destination.endsWith(".live.tmp"))
          return copy();
        ++failures;
        await fs.chmod(f.game, 0o500);
        try {
          return await copyProgramFile(source, destination, { noSelfCopy: true });
        } finally {
          await fs.chmod(f.game, 0o700);
        }
      });
      f.purge();
      await f.drain();
      expect(f.errors().at(-1)).toMatchObject({
        title: "Failed to purge ini edits",
        message: { code: "EACCES" },
      });
      expect(failures).toBe(1);
      expect(await f.values(file + ".base")).toEqual({ General: { owner: "global", tweak: "0" } });
      blocked = false;
      if (retry === "restart") await f.restart(await f.persistState());
      if (retry === "purge") {
        f.purge();
        await f.drain();
      } else expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
      for (const name of f.files)
        for (const suffix of ["", ".base", ".baked"])
          expect.soft(await f.values(path.join(f.game, name + suffix))).toEqual({
            General: { owner: "global", tweak: "0" },
          });
      expect((await fs.readdir(f.game)).filter((name) => /\.(tmp|pending)$/.test(name))).toEqual(
        [],
      );
    } finally {
      blocked = false;
      await fs.chmod(f.game, 0o700);
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each(
  [false, true].flatMap((wasPrivate) =>
    [false, true].flatMap((restart) =>
      ["live", "baked", "journal"].map((failure) => ({ wasPrivate, restart, failure })),
    ),
  ),
)(
  "recovers deployment rollback before feature swap: private=$wasPrivate, restart=$restart, $failure",
  async ({ wasPrivate, restart, failure }) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(wasPrivate);
    const file = path.join(f.game, "Skyrim.ini");
    const journal = file + ".baked.pending";
    let blocked = true;
    let failCopy = true;
    try {
      await f.deploymentBake();
      f.setFileOperation("renameAsync", (source, destination) => {
        if (
          blocked &&
          !failCopy &&
          failure !== "journal" &&
          destination === (failure === "live" ? file : file + ".baked")
        )
          throw Object.assign(new Error("rollback blocked"), { code: "EACCES" });
        return fs.rename(source, destination);
      });
      f.setFileOperation("unlinkAsync", (destination) => {
        if (failCopy && destination === journal) {
          failCopy = false;
          throw Object.assign(new Error("journal removal interrupted"), { code: "EIO" });
        }
        if (blocked && !failCopy && failure === "journal" && destination === journal)
          throw Object.assign(new Error("journal cleanup blocked"), { code: "EACCES" });
        return fs.unlink(destination);
      });

      const [result] = (await f.bakeResult()) as any[];
      expect(result.settingsBaked).toBe(false);
      expect(result.error).toBeInstanceOf(AggregateError);
      expect(await fs.stat(journal)).toBeDefined();
      if (restart) await f.restart(await f.persistState());
      blocked = false;
      f.enableTweak(false);
      f.edit("p", !wasPrivate);
      await f.drain();
      const outgoing = wasPrivate ? f.saved : f.backup;
      for (const name of f.files) {
        expect(await f.values(path.join(outgoing, name))).toEqual({
          General: { owner: wasPrivate ? "latest" : "global", tweak: "0" },
        });
        for (const suffix of ["", ".base", ".baked"])
          expect(await f.values(path.join(f.game, name + suffix))).toEqual({
            General: { owner: wasPrivate ? "global" : "private", tweak: "0" },
          });
      }
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
      expect((await fs.readdir(f.game)).filter((name) => /\.(tmp|pending)$/.test(name))).toEqual(
        [],
      );
    } finally {
      blocked = false;
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each(
  ["retry", "restart"].flatMap((retry) =>
    [false, true].flatMap((denied) =>
      [false, true].map((thirdPending) => ({ retry, denied, thirdPending })),
    ),
  ),
)(
  "cleans only owned purge temporaries after sibling denial: $denied, $retry, third pending=$thirdPending",
  async ({ retry, denied, thirdPending }) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false);
    const first = path.join(f.game, "Skyrim.ini");
    const sibling = path.join(f.game, "SkyrimPrefs.ini");
    const third = path.join(f.game, "SkyrimCustom.ini");
    const sentinel = sibling + ".baked.12345678-1234-4234-8234-123456789abc.tmp";
    const failures: Array<{ operation: string; file: string; code: string }> = [];
    let reached: () => void;
    let deny: () => void;
    let cleaned: () => void;
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const overlap = new Promise<void>((resolve) => {
      deny = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      cleaned = resolve;
    });
    let thirdReached: () => void;
    let thirdCleaned: () => void;
    let restored: () => void;
    const thirdReady = new Promise<void>((resolve) => {
      thirdReached = resolve;
    });
    const thirdCleanup = new Promise<void>((resolve) => {
      thirdCleaned = resolve;
    });
    const permissionRestored = new Promise<void>((resolve) => {
      restored = resolve;
    });
    let armed = false;
    try {
      for (const name of f.files)
        for (const suffix of ["", ".base", ".baked"])
          await fs.writeFile(
            path.join(f.game, name + suffix),
            `[General]\nowner=global-${name}\ntweak=0\n`,
          );
      await f.deploymentBake();
      await fs.writeFile(sentinel, "unrelated user temporary");
      f.setFileOperation("renameAsync", async (source, destination) => {
        if (armed && destination === sibling + ".baked.pending") {
          reached();
          await overlap;
        }
        // Control whether the third INI shares the directory denial.
        if (armed && destination === third + (thirdPending ? ".baked.pending" : ".baked.cleanup")) {
          thirdReached();
          await (thirdPending ? overlap : permissionRestored);
        }
        try {
          await fs.rename(source, destination);
        } catch (error) {
          failures.push({
            operation: "rename",
            file: source,
            code: (error as NodeJS.ErrnoException).code!,
          });
          throw error;
        }
      });
      f.setFileOperation("unlinkAsync", async (file) => {
        try {
          await fs.unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EACCES") {
            failures.push({ operation: "unlink", file, code: "EACCES" });
            const unlinksFor = (ini: string) =>
              failures.filter(
                (item) => item.operation === "unlink" && item.file.startsWith(ini + ".baked."),
              ).length;
            if (unlinksFor(sibling) === 2) cleaned();
            if (unlinksFor(third) === 2) thirdCleaned();
          }
          throw error;
        }
      });
      f.setCopy(async (source, destination, copy) => {
        if (!armed || source !== first + ".base" || !destination.endsWith(".live.tmp"))
          return copy();
        await Promise.all([ready, thirdReady]);
        if (denied) await fs.chmod(f.game, 0o500);
        deny();
        try {
          return await copyProgramFile(source, destination, { noSelfCopy: true });
        } finally {
          if (denied) await Promise.all([cleanup, ...(thirdPending ? [thirdCleanup] : [])]);
          await fs.chmod(f.game, 0o700);
          restored();
        }
      });
      armed = true;
      f.purge();
      await f.drain();
      armed = false;
      const temporaries = (await fs.readdir(f.game)).filter(
        (name) => name.endsWith(".tmp") && path.join(f.game, name) !== sentinel,
      );
      if (denied) {
        expect(
          failures.filter(
            (item) =>
              item.code === "EACCES" &&
              item.file.startsWith(sibling + ".baked.") &&
              item.file.endsWith(".tmp"),
          ),
        ).toHaveLength(3);
        if (thirdPending)
          expect(
            failures.filter(
              (item) =>
                item.code === "EACCES" &&
                item.file.startsWith(third + ".baked.") &&
                item.file.endsWith(".tmp"),
            ),
          ).toHaveLength(3);
        expect(temporaries).toHaveLength(thirdPending ? 4 : 2);
        expect(f.errors().at(-1)?.title).toBe("Failed to purge ini edits");
      } else {
        expect(failures).toEqual([]);
        expect(temporaries).toEqual([]);
        expect(f.errors()).toEqual([]);
      }
      if (retry === "restart") {
        await f.restart(await f.persistState());
        f.activate();
        await f.drain();
        expect(
          (await fs.readdir(f.game)).filter(
            (name) => /\.(tmp|pending|cleanup)$/.test(name) && path.join(f.game, name) !== sentinel,
          ),
        ).toEqual([]);
      }
      expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
      for (const name of f.files)
        for (const suffix of ["", ".base", ".baked"])
          expect(await f.values(path.join(f.game, name + suffix))).toEqual({
            General: { owner: `global-${name}`, tweak: "0" },
          });
      expect(await fs.readFile(sentinel, "utf8")).toBe("unrelated user temporary");
      expect(
        (await fs.readdir(f.game)).filter(
          (name) => /\.(tmp|pending|cleanup)$/.test(name) && path.join(f.game, name) !== sentinel,
        ),
      ).toEqual([]);
    } finally {
      armed = false;
      deny();
      cleaned();
      thirdCleaned();
      restored();
      await fs.chmod(f.game, 0o700);
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each(
  ["retry", "restart"].flatMap((retry) =>
    ["rollback-denied", "rollback-works", "saved-present", "no-failure", "external-edit"].map(
      (control) => ({
        retry,
        control,
      }),
    ),
  ),
)(
  "recovers optional bake before replaying settings copies: $control, $retry",
  async ({ retry, control }) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false);
    const file = path.join(f.game, "SkyrimCustom.ini");
    const journal = file + ".baked.pending";
    let armed = true;
    let hits = 0;
    let installingPrivate = false;
    try {
      for (const name of f.files) {
        for (const suffix of ["", ".base", ".baked"])
          await fs.writeFile(
            path.join(f.game, name + suffix),
            `[General]\nowner=global-${name}\ntweak=0\n`,
          );
        await fs.writeFile(path.join(f.saved, name), `[General]\nowner=private-${name}\ntweak=0\n`);
      }
      if (control !== "saved-present") await fs.unlink(path.join(f.saved, "SkyrimCustom.ini"));
      await fs.writeFile(
        path.join(f.root, "mods/tweak/INI Tweaks/SkyrimCustom.ini"),
        "[General]\noptional=mod\n",
      );
      f.onApply((profile) => {
        installingPrivate = !!profile.features?.local_game_settings;
      });
      f.setCopy(async (source, destination, copy) => {
        if (
          !armed ||
          !installingPrivate ||
          control === "no-failure" ||
          source !== file + ".baked" ||
          !destination.endsWith(".live.tmp")
        )
          return copy();
        ++hits;
        await fs.chmod(f.game, 0o500);
        try {
          return await copyProgramFile(source, destination, { noSelfCopy: true });
        } finally {
          if (control === "rollback-works") await fs.chmod(f.game, 0o700);
        }
      });
      f.edit("p", true);
      await f.drain();
      if (control !== "no-failure") {
        expect(hits).toBe(1);
        expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeDefined();
        if (control !== "rollback-works") {
          const reported = f.showError.mock.calls
            .map((call) => (call[2] as { error?: AggregateError })?.error)
            .find((error) => error instanceof AggregateError);
          expect(reported?.errors.map((error) => error.code)).toEqual(["EACCES", "EACCES"]);
          expect(await fs.stat(journal)).toBeDefined();
          const readLive = () =>
            fs.readFile(file).catch((error) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
              throw error;
            });
          const before = await readLive();
          if (retry === "restart") await f.restart(await f.persistState());
          expect(await readLive()).toEqual(before);
        }
      }
      armed = false;
      await fs.chmod(f.game, 0o700);
      if (control === "external-edit") {
        const pending = await fs.readFile(journal, "utf8");
        const base = await fs.readFile(file + ".base");
        await fs.writeFile(file, "[General]\noptional=user\n");
        if (retry === "restart") await f.restart(await f.persistState());
        else {
          f.activate();
          await f.drain();
        }
        expect(await fs.readFile(file, "utf8")).toBe("[General]\noptional=user\n");
        expect(await fs.readFile(journal, "utf8")).toBe(pending);
        expect(await fs.readFile(file + ".base")).toEqual(base);
        expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeDefined();
        const snapshot = JSON.parse(pending.split("\n")[0]).live;
        if (snapshot === null) await fs.unlink(file);
        else await fs.writeFile(file, Buffer.from(snapshot.content, "base64"));
      }
      if (retry === "restart") await f.restart(await f.persistState());
      else {
        f.activate();
        await f.drain();
      }
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
      expect(await f.values(file)).toEqual({
        General: {
          ...(control === "saved-present" ? { owner: "private-SkyrimCustom.ini", tweak: "0" } : {}),
          optional: "mod",
        },
      });
      expect(await f.values(file + ".base")).toEqual(
        control === "saved-present"
          ? { General: { owner: "private-SkyrimCustom.ini", tweak: "0" } }
          : {},
      );
      expect(await f.values(path.join(f.backup, "SkyrimCustom.ini"))).toEqual({
        General: { owner: "global-SkyrimCustom.ini", tweak: "0" },
      });
      if (control !== "saved-present")
        await expect(fs.stat(path.join(f.saved, "SkyrimCustom.ini"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      for (const name of ["Skyrim.ini", "SkyrimPrefs.ini"])
        expect(((await f.values(path.join(f.game, name + ".base"))) as any).General.owner).toBe(
          `private-${name}`,
        );
      expect(
        (await fs.readdir(f.game)).filter((name) => /\.(tmp|pending|cleanup)$/.test(name)),
      ).toEqual([]);
      await f.restart(await f.persistState());
      expect(await f.values(file)).toEqual({
        General: {
          ...(control === "saved-present" ? { owner: "private-SkyrimCustom.ini", tweak: "0" } : {}),
          optional: "mod",
        },
      });
    } finally {
      armed = false;
      await fs.chmod(f.game, 0o700);
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each(["", "../unrelated", "12345678-1234-4234-8234-123456789abc\n", "unreadable"])(
  "preserves files when temporary cleanup ownership is invalid: %s",
  async (invalid) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(false);
    const file = path.join(f.game, "Skyrim.ini");
    const record = file + ".baked.cleanup";
    const sentinel = file + ".baked.12345678-1234-4234-8234-123456789abc.tmp";
    try {
      const live = await fs.readFile(file);
      const base = await fs.readFile(file + ".base");
      await fs.writeFile(sentinel, "user file");
      await fs.writeFile(record, invalid);
      if (invalid === "unreadable") await fs.chmod(record, 0o000);
      const [result] = (await f.bakeResult()) as any[];
      expect(result.settingsBaked).toBe(false);
      if (invalid === "unreadable") expect(result.error.code).toBe("EACCES");
      else expect(result.error.message).toContain("INI temporary cleanup data is invalid");
      await f.restart(await f.persistState());
      expect(await f.bakeResult()).toMatchObject([{ settingsBaked: false }]);
      expect(await fs.readFile(file)).toEqual(live);
      expect(await fs.readFile(file + ".base")).toEqual(base);
      expect(await fs.readFile(sentinel, "utf8")).toBe("user file");
      await fs.chmod(record, 0o600);
      expect(await fs.readFile(record, "utf8")).toBe(invalid);
      await fs.unlink(record);
      expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
      expect(await fs.readFile(sentinel, "utf8")).toBe("user file");
    } finally {
      await fs.chmod(record, 0o600).catch(() => {});
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("joins a deliberately stalled startup before fixture cleanup", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false, "test[skyrim].ini", true);
  let release: () => void;
  let entered: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let restart: Promise<unknown>;
  try {
    const persisted = await unconfirmedSettings(f, true, true);
    let stalled = false;
    f.setCopy(async (_source, _destination, copy) => {
      if (!stalled) {
        stalled = true;
        entered();
        await gate;
      }
      return copy();
    });
    restart = f.restart(persisted);
    await ready;
    let settled = false;
    const joined = settleTestWork([restart]).then(() => {
      settled = true;
    });
    await waitForIO(20);
    expect(settled).toBe(false);
    expect(vi.isFakeTimers()).toBe(true);
    release();
    await joined;
    await expectConfirmedP(f);
    expect(vi.isFakeTimers()).toBe(true);
  } finally {
    release();
    await restart;
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test("retries after a partial temporary ownership write without publishing files", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(false);
  const file = path.join(f.game, "Skyrim.ini");
  const record = file + ".baked.cleanup";
  let armed = true;
  try {
    const snapshots = await Promise.all(
      ["", ".base", ".baked"].map((suffix) => fs.readFile(file + suffix)),
    );
    f.setFileOperation("writeFileAsync", async (destination, ...args) => {
      if (armed && destination === path.join(record + ".init", "owner")) {
        armed = false;
        await fs.writeFile(destination, "partial");
        throw Object.assign(new Error("ownership write interrupted"), { code: "ENOSPC" });
      }
      return (fs.writeFile as any)(destination, ...args);
    });
    expect(await f.bakeResult()).toMatchObject([
      { settingsBaked: false, error: { code: "ENOSPC" } },
    ]);
    expect(armed).toBe(false);
    await expect(fs.stat(record)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await Promise.all(["", ".base", ".baked"].map((suffix) => fs.readFile(file + suffix))),
    ).toEqual(snapshots);
    expect(
      (await fs.readdir(f.game)).filter((name) => /\.(tmp|pending|cleanup)$/.test(name)),
    ).toEqual([]);
    await f.restart(await f.persistState());
    expect(await f.bakeResult()).toEqual([{ settingsBaked: true }]);
  } finally {
    armed = false;
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

const sharedSettingsCases = ["/games/skyrim", "/games/SkYrIm Special Edition"].flatMap(
  (installation) =>
    [false, true].flatMap((privateP) =>
      [false, true].flatMap((privateE) =>
        [false, true].map((separate) => ({ installation, privateP, privateE, separate })),
      ),
    ),
);

test.each(sharedSettingsCases)(
  "isolates resolved Skyrim and Enderal INIs: %j",
  async ({ installation, privateP, privateE, separate }) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(privateP, "test[skyrim].ini", false, false, "skyrimse", {
      installation,
      privateSettings: privateE,
      separate,
    });
    const owner = async (directory: string, file: string) =>
      ((await f.values(path.join(directory, file))) as any).General.owner;
    try {
      for (const file of f.files) {
        await fs.writeFile(path.join(f.game, file), `[General]\nowner=p-edit-${file}\ntweak=0\n`);
        await fs.writeFile(
          path.join(f.enderalSaved, file),
          `[General]\nowner=e-saved-${file}\ntweak=0\n`,
        );
      }
      await f.restart(await f.persistState());
      await f.switchTo("e");
      expect(f.errors()).toEqual([]);
      expect(f.showError).not.toHaveBeenCalled();
      for (const file of f.files) {
        expect.soft(await owner(f.saved, file)).toBe(privateP ? `p-edit-${file}` : "private");
        expect
          .soft(await owner(f.enderalSaved, file))
          .toBe(privateE && separate ? "enderal-latest" : `e-saved-${file}`);
        expect
          .soft(await owner(f.enderalGame, file))
          .toBe(
            privateE
              ? separate
                ? "enderal-latest"
                : `e-saved-${file}`
              : separate
                ? "enderal-global"
                : privateP
                  ? "global"
                  : `p-edit-${file}`,
          );
        await fs.writeFile(
          path.join(f.enderalGame, file),
          `[General]\nowner=e-edit-${file}\ntweak=0\n`,
        );
      }
      await f.restart(await f.persistState());
      await f.switchTo("p");
      expect(f.errors()).toEqual([]);
      expect(f.showError).not.toHaveBeenCalled();
      for (const file of f.files) {
        expect.soft(await owner(f.saved, file)).toBe(privateP ? `p-edit-${file}` : "private");
        expect
          .soft(await owner(f.enderalSaved, file))
          .toBe(privateE ? `e-edit-${file}` : `e-saved-${file}`);
        expect
          .soft(await owner(f.game, file))
          .toBe(
            privateP
              ? `p-edit-${file}`
              : separate || privateE
                ? `p-edit-${file}`
                : `e-edit-${file}`,
          );
        if (separate) expect.soft(await owner(f.enderalGame, file)).toBe(`e-edit-${file}`);
      }
      await f.switchTo("e");
      for (const file of f.files)
        expect.soft(await owner(f.enderalGame, file)).toBe(`e-edit-${file}`);
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
      expect(f.errors()).toEqual([]);
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each(["snapshot", "restore", "backup", "install", "bake"])(
  "recovers shared INI ownership after native copy obstruction: %s",
  async (failure) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(true, "test[skyrim].ini", false, false, "skyrimse", {
      installation: "/games/SkYrIm",
      privateSettings: true,
    });
    let obstruction: string;
    let installing = false;
    try {
      f.setCopy(async (source, destination, copy) => {
        if (source === path.join(f.enderalSaved, "SkyrimPrefs.ini")) installing = true;
        const matches =
          (failure === "snapshot" && destination === path.join(f.saved, "SkyrimPrefs.ini")) ||
          (failure === "restore" && source === path.join(f.backup, "SkyrimPrefs.ini")) ||
          (failure === "backup" && destination === path.join(f.enderalBackup, "SkyrimPrefs.ini")) ||
          (failure === "install" && source === path.join(f.enderalSaved, "SkyrimPrefs.ini")) ||
          (failure === "bake" &&
            installing &&
            source === path.join(f.game, "SkyrimPrefs.ini.baked"));
        if (matches && !obstruction) {
          obstruction = failure === "bake" ? path.join(f.game, "SkyrimPrefs.ini") : destination;
          await fs.rename(obstruction, obstruction + ".held");
          await fs.mkdir(obstruction);
        }
        await copy();
      });
      await f.switchTo("e");
      expect(obstruction).toBeDefined();
      const pending = JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending;
      expect(pending.oldProfile.id).toBe("p");
      expect(pending.newProfile.id).toBe("e");
      expect(f.showError).toHaveBeenCalled();
      f.setCopy(undefined);
      await fs.rmdir(obstruction);
      await fs.rename(obstruction + ".held", obstruction);
      obstruction = undefined;
      await f.restart(await f.persistState());
      const recovered = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
      expect(recovered.pending).toBeUndefined();
      expect(recovered.installed.enderalspecialedition.id).toBe("e");
      expect(recovered.installed.skyrimse).toBeUndefined();
      for (const file of f.files) {
        const owner = async (directory: string, suffix = "") =>
          ((await f.values(path.join(directory, file + suffix))) as any).General.owner;
        expect(await owner(f.saved)).toBe("latest");
        expect(await owner(f.enderalSaved)).toBe("enderal-private");
        expect(await owner(f.enderalBackup)).toBe("global");
        for (const suffix of ["", ".base", ".baked"])
          expect(await owner(f.game, suffix)).toBe("enderal-private");
      }
      expect(f.errors()).toEqual([]);
      await f.switchTo("p");
      for (const file of f.files)
        expect(((await f.values(path.join(f.game, file))) as any).General.owner).toBe("latest");
    } finally {
      f.setCopy(undefined);
      if (obstruction) {
        await fs.rm(obstruction, { recursive: true, force: true });
        await fs.rename(obstruction + ".held", obstruction);
      }
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("shared ownership survives leaving for an unrelated game and inactive feature edits", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(true, "test[skyrim].ini", false, false, "skyrimse", {
    installation: "/games/skyrim",
    privateSettings: true,
  });
  try {
    await f.switchTo("e");
    const live = await Promise.all(f.files.map((file) => fs.readFile(path.join(f.game, file))));
    f.edit("p", false);
    await f.drain();
    for (const [index, file] of f.files.entries())
      expect(await fs.readFile(path.join(f.game, file))).toEqual(live[index]);
    f.edit("p", true);
    await f.drain();
    await f.switchTo("other");
    await f.restart(await f.persistState());
    await f.switchTo("p");
    for (const file of f.files) {
      expect(((await f.values(path.join(f.game, file))) as any).General.owner).toBe("latest");
      expect(((await f.values(path.join(f.enderalSaved, file))) as any).General.owner).toBe(
        "enderal-private",
      );
    }
    expect(f.errors()).toEqual([]);
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each(["bootstrap", "legacy", "ambiguous-pending", "unconfirmed-legacy"])(
  "loads shared ownership safely from %s settings data",
  async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(true, "test[skyrim].ini", false, false, "skyrimse", {
      installation: "/games/SkYrIm",
      privateSettings: true,
    });
    try {
      const journal = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
      if (mode === "bootstrap") await fs.unlink(f.recoveryFile);
      else {
        journal.installed.enderalspecialedition = f.state().persistent.profiles.e;
        if (mode === "ambiguous-pending") {
          const live = f.game;
          journal.pending = {
            oldProfile: f.state().persistent.profiles.e,
            newProfile: f.state().persistent.profiles.e,
            completed: 0,
            steps: [
              { sourcePath: live, destinationPath: f.enderalSaved, copyType: "GloPro" },
              { sourcePath: f.enderalBackup, destinationPath: live, copyType: "BacGlo" },
              { sourcePath: live, destinationPath: f.enderalBackup, copyType: "GloBac" },
              { sourcePath: f.enderalSaved, destinationPath: live, copyType: "ProGlo" },
            ].map((step) => ({
              sourcePath: step.sourcePath,
              destinationPath: step.destinationPath,
              files: f.files.map((name) => ({ name, optional: name === "SkyrimCustom.ini" })),
              copyType: step.copyType,
            })),
          };
        }
        await fs.writeFile(f.recoveryFile, JSON.stringify(journal));
        if (mode === "unconfirmed-legacy")
          for (const file of f.files)
            for (const suffix of ["", ".base", ".baked"])
              await fs.writeFile(
                path.join(f.game, file + suffix),
                "[General]\nowner=unconfirmed-e\n",
              );
      }
      const snapshotFiles = [
        ...(mode !== "bootstrap" ? [f.recoveryFile] : []),
        ...f.files.flatMap((file) => [
          ...["", ".base", ".baked"].map((suffix) => path.join(f.game, file + suffix)),
          path.join(f.saved, file),
          path.join(f.backup, file),
          path.join(f.enderalSaved, file),
          path.join(f.enderalBackup, file),
        ]),
      ];
      const before = await Promise.all(snapshotFiles.map((file) => fs.readFile(file)));
      await f.restart(await f.persistState());
      for (const [index, file] of snapshotFiles.entries())
        expect(await fs.readFile(file)).toEqual(before[index]);
      if (mode !== "bootstrap") {
        expect(f.errors()).toEqual([
          expect.objectContaining({
            title: "Failed to recover game settings",
            message: expect.objectContaining({
              message: "Shared game settings ownership is ambiguous during recovery",
            }),
          }),
        ]);
      } else {
        const recovered = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
        expect(recovered.installed.skyrimse.id).toBe("p");
        expect(recovered.installed.enderalspecialedition).toBeUndefined();
        await f.switchTo("e");
        for (const file of f.files)
          expect(((await f.values(path.join(f.enderalSaved, file))) as any).General.owner).toBe(
            "enderal-private",
          );
        expect(f.errors()).toEqual([]);
      }
    } finally {
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test.each([false, true])(
  "reconciles shared INIs to confirmed Skyrim after native database restart, private Enderal=%s",
  async (privateE) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(true, "test[skyrim].ini", true, false, "skyrimse", {
      installation: "/games/SkYrIm",
      privateSettings: privateE,
    });
    let finish: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let reached: () => void;
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    try {
      f.setSaves(true);
      f.updateProfile("e", { features: { local_game_settings: privateE, local_saves: true } });
      await f.drain();
      f.beforeConfirmation(() => {
        reached();
        return gate;
      });
      f.queueSwitch("e");
      await ready;
      expect(f.state().settings.profiles.activeProfileId).toBe("p");
      expect(
        JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).installed.enderalspecialedition.id,
      ).toBe("e");
      for (const file of f.files)
        await fs.writeFile(
          path.join(f.game, file),
          `[General]\nowner=unconfirmed-e-${file}\ntweak=0\n`,
        );
      const persisted = await f.persistState();
      finish();
      await f.drain();
      await f.restart(persisted);
      const journal = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
      expect(journal.pending).toBeUndefined();
      expect(journal.installed.skyrimse.id).toBe("p");
      expect(journal.installed.enderalspecialedition).toBeUndefined();
      for (const file of f.files) {
        expect(((await f.values(path.join(f.game, file))) as any).General.owner).toBe("latest");
        expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("latest");
        expect(((await f.values(path.join(f.enderalSaved, file))) as any).General.owner).toBe(
          privateE ? `unconfirmed-e-${file}` : "enderal-private",
        );
      }
      expect(
        ((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.SLocalSavePath,
      ).toBe(path.join("Saves", "p") + path.sep);
      await f.switchTo("e");
      for (const file of f.files)
        expect(((await f.values(path.join(f.game, file))) as any).General.owner).toBe(
          `unconfirmed-e-${file}`,
        );
      expect(
        ((await f.values(path.join(f.game, "Skyrim.ini"))) as any).General.SLocalSavePath,
      ).toBe(path.join("..", "Enderal Special Edition", "Saves", "e") + path.sep);
      expect(f.errors()).toEqual([]);
    } finally {
      finish();
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("first activation of separate Enderal files preserves its saved private INIs", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(true, "test[skyrim].ini", false, false, "skyrimse", {
    installation: "/games/skyrim",
    privateSettings: true,
    separate: true,
  });
  try {
    const journal = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
    delete journal.installed.enderalspecialedition;
    await fs.writeFile(f.recoveryFile, JSON.stringify(journal));
    const state = await f.persistState();
    delete state.settings.profiles.lastActiveProfile.enderalspecialedition;
    for (const file of f.files)
      for (const suffix of ["", ".base", ".baked"])
        await fs.writeFile(
          path.join(f.enderalGame, file + suffix),
          "[General]\nowner=first-global\n",
        );
    await f.restart(state);
    await f.switchTo("e");
    for (const file of f.files) {
      expect(((await f.values(path.join(f.enderalSaved, file))) as any).General.owner).toBe(
        "enderal-private",
      );
      expect(((await f.values(path.join(f.enderalGame, file))) as any).General.owner).toBe(
        "enderal-private",
      );
      expect(((await f.values(path.join(f.enderalBackup, file))) as any).General.owner).toBe(
        "first-global",
      );
    }
    expect(f.errors()).toEqual([]);
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test("imports stale feature flags using the installed INI owner", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(true);
  try {
    let deny = true;
    f.onApply((_profile, file, ini) => {
      if (deny && file === path.join(f.game, "Skyrim.ini"))
        ini.data.General.tweak = "invalid\nvalue";
    });
    f.edit("p", false);
    await f.drain();
    const before = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
    expect(before.pending).toBeUndefined();
    expect(before.installed.skyrimse.features.local_game_settings).toBe(true);
    expect(f.state().persistent.profiles.p.features.local_game_settings).toBe(false);
    deny = false;
    const source = await f.importProfile(true);
    for (const file of f.files) {
      expect(((await f.values(path.join(f.game, file))) as any).General.owner).toBe("global");
      expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
      expect(((await f.values(path.join(f.saved, file))) as any).General.owner).toBe("latest");
    }
    for (const enabled of [true, false]) {
      f.edit("p", enabled);
      await f.drain();
      await f.restart();
      for (const file of f.files) {
        expect(((await f.values(path.join(f.game, file))) as any).General.owner).toBe(
          enabled ? "latest" : "global",
        );
        expect(((await f.values(path.join(f.backup, file))) as any).General.owner).toBe("global");
        expect(((await f.values(path.join(source, "skyrimse", file))) as any).General.owner).toBe(
          "global",
        );
        expect(
          ((await f.values(path.join(source, "skyrimse/profiles/p", file))) as any).General.owner,
        ).toBe("private");
      }
    }
    expect(f.errors()).toEqual([]);
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test.each([false, true])(
  "imports and resumes a pending ownership swap, private=%s",
  async (wasPrivate) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const f = await recoveryFixture(wasPrivate);
    let obstructed = false;
    try {
      f.obstruct(".base");
      obstructed = true;
      f.edit("p", !wasPrivate);
      await f.drain();
      const original = await fs.readFile(f.recoveryFile);
      expect(JSON.parse(original.toString()).pending).toBeDefined();
      const source = await f.importProfile(true);
      const imported = JSON.parse(await fs.readFile(f.recoveryFile, "utf8"));
      expect(imported.pending).toBeDefined();
      for (const step of imported.pending.steps) {
        for (const value of [step.sourcePath, step.destinationPath]) {
          expect(value.startsWith(source + path.sep)).toBe(false);
          expect(
            value.startsWith(path.dirname(f.recoveryFile) + path.sep) || value === f.game,
          ).toBe(true);
        }
      }
      await f.repair();
      obstructed = false;
      await f.restart();
      expect(JSON.parse(await fs.readFile(f.recoveryFile, "utf8")).pending).toBeUndefined();
      for (const enabled of [true, false]) {
        f.edit("p", enabled);
        await f.drain();
        await f.restart();
        for (const name of f.files) {
          expect(((await f.values(path.join(f.game, name))) as any).General.owner).toBe(
            enabled ? (wasPrivate ? "latest" : "private") : "global",
          );
          expect(((await f.values(path.join(f.backup, name))) as any).General.owner).toBe("global");
        }
        expect(await fs.readFile(path.join(source, "local-game-settings.json"))).toEqual(original);
      }
    } finally {
      if (obstructed) await f.repair();
      await f.cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("import preserves the installed owner of shared Skyrim and Enderal INIs", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const f = await recoveryFixture(true, "test[skyrim].ini", false, false, "skyrimse", {
    installation: "/games/SkYrIm",
    privateSettings: true,
  });
  try {
    const original = await fs.readFile(f.recoveryFile);
    const source = await f.importProfile(true);
    for (const [id, owner] of [
      ["e", "enderal-private"],
      ["p", "latest"],
    ]) {
      await f.switchTo(id);
      await f.restart();
      for (const name of f.files)
        expect(((await f.values(path.join(f.game, name))) as any).General.owner).toBe(owner);
    }
    f.edit("p", false);
    await f.drain();
    for (const name of f.files) {
      for (const [directory, owner] of [
        [f.game, "global"],
        [f.backup, "global"],
        [path.join(path.dirname(f.backup), "enderalspecialedition"), "global"],
        [path.join(source, "skyrimse"), "global"],
        [path.join(source, "skyrimse/profiles/p"), "private"],
        [path.join(source, "enderalspecialedition"), "enderal-global"],
        [path.join(source, "enderalspecialedition/profiles/e"), "enderal-private"],
      ])
        expect(((await f.values(path.join(directory, name))) as any).General.owner).toBe(owner);
    }
    expect(await fs.readFile(path.join(source, "local-game-settings.json"))).toEqual(original);
    expect(f.errors()).toEqual([]);
    expect(f.showError).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
