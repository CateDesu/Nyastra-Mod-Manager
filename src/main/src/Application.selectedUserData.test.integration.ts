import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { IParameters } from "@vortex/shared/cli";
import type { DiffOperation } from "@vortex/shared/ipc";
import { currentStatePath } from "@vortex/shared/state";
import { applyMiddleware, createStore, type Middleware, type Reducer } from "redux";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  userData: "",
  appData: "",
  mainBase: "",
  queryTerminals: [] as string[],
  queryDone: undefined as (() => void) | undefined,
}));

// Electron and UI boundaries are fixtures. Persistence and queries run natively.
vi.mock("electron", () => ({
  app: {
    name: "Nyastra fixture",
    getVersion: () => "2.9.2",
    getPath: (name: string) => (name === "userData" ? fixture.userData : fixture.appData),
  },
  ipcMain: {
    on: vi.fn<(...args: unknown[]) => void>(),
    removeHandler: vi.fn<(...args: unknown[]) => void>(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  protocol: {},
  shell: {},
}));
vi.mock("electron-context-menu", () => ({ default: vi.fn<(...args: unknown[]) => void>() }));
vi.mock("./getVortexPath", () => ({
  getVortexPath: (name: string) => {
    if (name.startsWith("base")) return fixture.mainBase;
    return name === "userData" ? fixture.userData : fixture.appData;
  },
  setVortexPath: (name: string, value: string) => {
    if (name === "userData") fixture.userData = value;
  },
}));
vi.mock("./logging", () => ({
  log: vi.fn<(level: string, message: string) => void>((_level, message) => {
    if (
      [
        "No query files found or parse error",
        "No queries found, skipping query system initialization",
        "DuckDBSingleton not initialized, skipping query system",
        "Query system initialized",
        "Failed to initialize query system",
      ].includes(message)
    ) {
      fixture.queryTerminals.push(message);
      fixture.queryDone?.();
    }
  }),
  setupLogging: vi.fn<(...args: unknown[]) => void>(),
  changeLogPath: vi.fn<(...args: unknown[]) => void>(),
}));
vi.mock("./ipc", () => ({
  betterIpcMain: {
    on: vi.fn<(...args: unknown[]) => void>(),
    handle: vi.fn<(...args: unknown[]) => void>(),
    send: vi.fn<(...args: unknown[]) => void>(),
  },
}));
vi.mock("./errorHandling", () => ({
  isQuitting: () => false,
  markQuitting: vi.fn<(...args: unknown[]) => void>(),
  terminate: (error: Error) => {
    throw error;
  },
  terminateAsync: vi.fn<(...args: unknown[]) => void>(),
}));
vi.mock("./errorReporting", () => ({
  disableErrorReporting: vi.fn<(...args: unknown[]) => void>(),
  reportCrash: vi.fn<(...args: unknown[]) => void>(),
}));
vi.mock("./MainWindow", () => ({ default: vi.fn<() => void>() }));
vi.mock("./SplashScreen", () => ({ default: vi.fn<() => void>() }));
vi.mock("./TrayIcon", () => ({ default: vi.fn<() => void>() }));
vi.mock("./extensions", () => ({ setupMainExtensions: vi.fn<(...args: unknown[]) => void>() }));
vi.mock("./bsdiff/host", () => ({ shutdownBsdiffWorker: vi.fn<(...args: unknown[]) => void>() }));
vi.mock("./hash/host", () => ({ shutdownHashWorker: vi.fn<(...args: unknown[]) => void>() }));
vi.mock("./telemetry/state", () => ({
  isTelemetryEnabled: () => false,
  setTelemetryEnabled: vi.fn<(...args: unknown[]) => void>(),
  setTelemetryInstanceId: vi.fn<(...args: unknown[]) => void>(),
}));

import Application from "./Application";
import { parseCommandline } from "./cli";
import { changeLogPath } from "./logging";
import DuckDBSingleton from "./store/DuckDBSingleton";
import LevelPersist from "./store/LevelPersist";
import {
  closeMainPersistence,
  getMainPersistor,
  getDatabase,
  readHiveData,
  readPersistedValue,
  writePersistedValue,
} from "./store/mainPersistence";

// Invoke the real private method without constructing an Electron application.
type PersistenceApplication = {
  mArgs: IParameters;
  mBasePath: string;
  mLevelPersistors: LevelPersist[];
  mAppMetadata: { instanceId: string; commandLine: IParameters };
  setupPersistence(repair?: boolean): Promise<void>;
};

it.each([true, false])(
  "main window read before renderer write stays committed, rollback %s",
  async (rollback) => {
    const root = await mkdtemp(path.join(tmpdir(), "window-reader-"));
    const dataPath = path.join(root, "user-data");
    fixture.userData = dataPath;
    fixture.appData = path.join(root, "config");
    fixture.mainBase = path.resolve(import.meta.dirname, "../build");
    const done = Promise.withResolvers<void>();
    fixture.queryDone = () => done.resolve();
    const resume = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let write: Promise<void> | undefined;
    try {
      await mkdir(dataPath, { recursive: true });
      const startup = path.join(fixture.appData, "Nyastra fixture");
      await mkdir(startup, { recursive: true });
      await writeFile(path.join(startup, "startup.json"), "{}");
      const seeded = await LevelPersist.create(path.join(dataPath, currentStatePath));
      await seeded.setItem(
        ["settings", "window"],
        JSON.stringify({
          width: 1280,
          height: 720,
          maximized: false,
          "display###name": "Desk",
        }),
      );
      await seeded.setItem(["app", "instanceId"], '"synthetic"');
      await seeded.close();
      const application = Object.assign(Object.create(Application.prototype), {
        mArgs: parseCommandline(["/fixture/program", "--user-data", dataPath], false),
        mBasePath: dataPath,
        mLevelPersistors: [],
      }) as PersistenceApplication;
      await application.setupPersistence(false);
      await done.promise;
      const persist = application.mLevelPersistors[0]!;
      expect(await readPersistedValue("settings", ["window", "maximized"])).toBe(false);
      const captured = Promise.withResolvers<void>();
      const beforeCommit = Promise.withResolvers<void>();
      const nativeRead = persist.connection.runAndReadAll.bind(persist.connection);
      let paused = false;
      vi.spyOn(persist.connection, "runAndReadAll").mockImplementation(async (sql, ...args) => {
        const reader = await nativeRead(sql, ...args);
        if (!paused && sql.includes("WHERE key IN")) {
          paused = true;
          captured.resolve();
          await resume.promise;
        }
        return reader;
      });
      const nativeRun = persist.connection.run.bind(persist.connection);
      vi.spyOn(persist.connection, "run").mockImplementation(async (sql, ...args) => {
        if (sql === "COMMIT") {
          beforeCommit.resolve();
          await finish.promise;
          if (rollback) throw new Error("fixture commit failure");
        }
        return nativeRun(sql, ...args);
      });
      const read = readPersistedValue("settings", ["window", "maximized"]);
      await captured.promise;
      const ipc = getMainPersistor()!;
      ipc.applyDiffOperations("settings", [
        { type: "set", path: ["window", "maximized"], value: true },
      ]);
      write = ipc.finalizeWrite();
      await Promise.race([beforeCommit.promise, delay(100)]);
      resume.resolve();
      const observed = await read;
      finish.resolve();
      await write;
      vi.restoreAllMocks();
      expect(await readPersistedValue("settings", ["window", "maximized"])).toBe(!rollback);
      expect(await readPersistedValue("settings", ["window", "display###name"])).toBe("Desk");
      await closeMainPersistence();
      DuckDBSingleton.getInstance().close();
      const reopened = await LevelPersist.create(path.join(dataPath, currentStatePath));
      expect(await reopened.readStateValue(["settings", "window", "maximized"])).toBe(!rollback);
      await reopened.close();
      expect(observed).toBe(false);
    } finally {
      resume.resolve();
      finish.resolve();
      await write;
      vi.restoreAllMocks();
      await closeMainPersistence();
      DuckDBSingleton.getInstance().close();
      fixture.queryDone = undefined;
      await rm(root, { recursive: true, force: true });
    }
  },
);

const scenarios = [
  { name: "implicit default", option: "none", invalidDefault: false },
  { name: "explicit identical default", option: "default", invalidDefault: false },
  { name: "healthy custom", option: "custom", invalidDefault: false },
  { name: "absent custom directory", option: "new-custom", invalidDefault: false },
  { name: "unusable default with valid custom", option: "custom", invalidDefault: true },
  { name: "default symlink alias", option: "alias", invalidDefault: false },
];

it.each(scenarios)("starts one selected database: $name", async (scenario) => {
  const root = await mkdtemp(path.join(tmpdir(), "selected-user-data-"));
  const defaultPath = path.join(root, "default");
  const customPath = path.join(root, "custom");
  const aliasPath = path.join(root, "alias");
  const appData = path.join(root, "config");
  const isNew = scenario.option === "new-custom";
  const isCustom = scenario.option === "custom" || isNew;
  const target = isCustom ? customPath : defaultPath;
  const optionPath = scenario.option === "alias" ? aliasPath : target;
  const expectedName = isNew
    ? "New custom profile"
    : isCustom
      ? "Custom profile"
      : "Default profile";
  const invalidBytes = Buffer.from("unusable default database\0exact bytes\xff", "latin1");
  const profileKey = ["persistent", "profiles", "p", "name"];
  const instanceKey = ["app", "instanceId"];
  const attempts: Array<{ directory: string; repair: boolean | undefined; settled: boolean }> = [];
  let singleton = DuckDBSingleton.getInstance();
  let application: PersistenceApplication | undefined;
  let startupError: unknown;
  let selectedName: unknown;
  let selectedInstanceId: unknown;
  let opened: Array<[string, string]>;
  let attachedAfterCleanup: Array<[string, string]>;
  let finalName: unknown;
  let finalInstanceId: unknown;
  let defaultName: unknown;
  let preservedInvalidBytes: Buffer | undefined;
  let queryTerminals: string[];
  let startupVersion: unknown;
  let loggingPaths: unknown[];
  let metadata: PersistenceApplication["mAppMetadata"] | undefined;
  fixture.mainBase = path.resolve(import.meta.dirname, "../build");
  fixture.queryTerminals = [];
  const queryDone = Promise.withResolvers<void>();
  fixture.queryDone = () => queryDone.resolve();
  vi.clearAllMocks();

  const seed = async (directory: string, name: string, instanceId: string) => {
    const persist = await LevelPersist.create(path.join(directory, currentStatePath));
    try {
      await persist.setItem(profileKey, JSON.stringify(name));
      await persist.setItem(instanceKey, JSON.stringify(instanceId));
    } finally {
      await persist.close();
    }
  };
  const verify = async (directory: string) => {
    const persist = await LevelPersist.create(path.join(directory, currentStatePath));
    try {
      return [await persist.getItem(profileKey), await persist.getItem(instanceKey)];
    } finally {
      await persist.close();
    }
  };

  try {
    await mkdir(defaultPath, { recursive: true });
    await mkdir(path.join(appData, "Nyastra fixture"), { recursive: true });
    const startupFile = path.join(appData, "Nyastra fixture", "startup.json");
    await writeFile(startupFile, "{}");
    await symlink(defaultPath, aliasPath);
    if (scenario.invalidDefault) {
      await writeFile(path.join(defaultPath, currentStatePath), invalidBytes);
    } else {
      await seed(defaultPath, "Default profile", "default-instance");
    }
    if (!isNew) {
      await mkdir(customPath, { recursive: true });
      await seed(customPath, "Custom profile", "custom-instance");
    }
    expect([...singleton.attachedDatabases]).toEqual([]);
    singleton.close();
    singleton = DuckDBSingleton.getInstance();
    fixture.userData = defaultPath;
    fixture.appData = appData;
    const args = parseCommandline(
      [
        "/fixture/nyastra-mod-manager",
        ...(scenario.option === "none" ? [] : ["--user-data", optionPath]),
      ],
      false,
    );
    const create = LevelPersist.create.bind(LevelPersist);
    vi.spyOn(LevelPersist, "create").mockImplementation(async (directory, tries, repair) => {
      const attempt = { directory, repair, settled: false };
      attempts.push(attempt);
      try {
        return await create(directory, tries, repair);
      } finally {
        attempt.settled = true;
      }
    });
    application = Object.assign(Object.create(Application.prototype), {
      mArgs: args,
      mBasePath: defaultPath,
      mLevelPersistors: [],
    }) as PersistenceApplication;
    try {
      await application.setupPersistence();
      if (isNew) {
        await writePersistedValue("persistent", ["profiles", "p", "name"], expectedName);
      }
      selectedName = await readPersistedValue("persistent", ["profiles", "p", "name"]);
      selectedInstanceId = await readPersistedValue("app", ["instanceId"]);
    } catch (error) {
      startupError = error;
    }
    if (getMainPersistor() !== undefined) await queryDone.promise;
    queryTerminals = [...fixture.queryTerminals];
    opened = [...singleton.attachedDatabases];
    metadata = application.mAppMetadata;
    loggingPaths = vi.mocked(changeLogPath).mock.calls.map(([directory]) => directory);
    startupVersion = (JSON.parse(await readFile(startupFile, "utf8")) as { storeVersion: string })
      .storeVersion;
    await closeMainPersistence();
    for (const persist of application.mLevelPersistors) await persist.close();
    attachedAfterCleanup = [...singleton.attachedDatabases];
    vi.restoreAllMocks();
    [finalName, finalInstanceId] = await verify(target);
    if (scenario.invalidDefault) {
      preservedInvalidBytes = await readFile(path.join(defaultPath, currentStatePath));
    } else {
      [defaultName] = await verify(defaultPath);
    }
    expect([...singleton.attachedDatabases]).toEqual([]);
  } finally {
    if (getMainPersistor() !== undefined) await queryDone.promise;
    await closeMainPersistence();
    for (const persist of application?.mLevelPersistors ?? []) await persist.close();
    vi.restoreAllMocks();
    const remaining = [...singleton.attachedDatabases];
    singleton.close();
    fixture.queryDone = undefined;
    await rm(root, { recursive: true, force: true });
    expect(remaining, "all native database owners detach before cleanup").toEqual([]);
  }

  expect(attempts.every((attempt) => attempt.settled)).toBe(true);
  expect(attachedAfterCleanup).toEqual([]);
  expect(finalName, "selected saved profile survives startup and independent reopen").toBe(
    JSON.stringify(expectedName),
  );
  expect(preservedInvalidBytes).toEqual(scenario.invalidDefault ? invalidBytes : undefined);
  expect(defaultName).toBe(scenario.invalidDefault ? undefined : JSON.stringify("Default profile"));
  expect(startupError, "a selected valid profile must start").toBeUndefined();
  expect(queryTerminals).toEqual(["Query system initialized"]);
  expect(selectedName).toBe(expectedName);
  expect(finalInstanceId).toBe(JSON.stringify(selectedInstanceId));
  expect(selectedInstanceId).toEqual(expect.any(String));
  expect(selectedInstanceId).toBe(
    isNew ? metadata?.instanceId : isCustom ? "custom-instance" : "default-instance",
  );
  expect(metadata?.instanceId).toBe(selectedInstanceId);
  expect(metadata?.commandLine.userData).toBe(scenario.option === "none" ? undefined : optionPath);
  expect(startupVersion).toBe("2.9.2");
  expect(loggingPaths).toEqual(scenario.option === "none" ? [] : [optionPath]);
  expect(attempts).toEqual([
    { directory: path.join(optionPath, currentStatePath), repair: false, settled: true },
  ]);
  expect(opened.map(([, directory]) => directory)).toEqual([
    path.join(optionPath, currentStatePath),
  ]);
});

it.each(["restore", "merge"] as const)(
  "applies %s to the selected database and finishes profile import",
  async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "selected-backup-"));
    const defaultPath = path.join(root, "default");
    const customPath = path.join(root, "custom");
    const configPath = path.join(root, "config");
    const backupPath = path.join(root, "backup.json");
    const startupPath = path.join(configPath, "Nyastra fixture");
    const importMarker = path.join(customPath, "nyastra-import-complete.json");
    const extensionPath = path.join(customPath, "plugins", "local-game");
    const invalidDefault = Buffer.from("unusable default remains untouched");
    const originalKey = ["persistent", "profiles", "original", "name"];
    const restoredKey = ["persistent", "profiles", "restored", "name"];
    const extensionKey = ["app", "extensions", "local-game", "path"];
    const attempts: Array<{ directory: string; repair: boolean | undefined; settled: boolean }> =
      [];
    let singleton = DuckDBSingleton.getInstance();
    let application: PersistenceApplication | undefined;
    const queryDone = Promise.withResolvers<void>();
    fixture.queryDone = () => queryDone.resolve();
    fixture.queryTerminals = [];
    fixture.mainBase = path.resolve(import.meta.dirname, "../build");
    fixture.userData = defaultPath;
    fixture.appData = configPath;
    vi.clearAllMocks();

    try {
      await mkdir(defaultPath, { recursive: true });
      await mkdir(extensionPath, { recursive: true });
      await mkdir(startupPath, { recursive: true });
      await writeFile(path.join(startupPath, "startup.json"), "{}");
      await writeFile(path.join(defaultPath, currentStatePath), invalidDefault);
      await writeFile(importMarker, JSON.stringify({ version: 1, source: "/previous/Vortex" }));
      const seeded = await LevelPersist.create(path.join(customPath, currentStatePath));
      try {
        await seeded.setItem(originalKey, JSON.stringify("Original profile"));
        await seeded.setItem(extensionKey, JSON.stringify("/previous/Vortex/plugins/local-game"));
      } finally {
        await seeded.close();
      }
      expect([...singleton.attachedDatabases]).toEqual([]);
      singleton.close();
      singleton = DuckDBSingleton.getInstance();
      const create = LevelPersist.create.bind(LevelPersist);
      vi.spyOn(LevelPersist, "create").mockImplementation(async (directory, tries, repair) => {
        const attempt = { directory, repair, settled: false };
        attempts.push(attempt);
        try {
          return await create(directory, tries, repair);
        } finally {
          attempt.settled = true;
        }
      });
      application = Object.assign(Object.create(Application.prototype), {
        mArgs: parseCommandline(
          ["/fixture/nyastra-mod-manager", "--user-data", customPath, `--${mode}`, backupPath],
          false,
        ),
        mBasePath: defaultPath,
        mLevelPersistors: [],
      }) as PersistenceApplication;
      await writeFile(
        backupPath,
        JSON.stringify({ persistent: { profiles: { restored: { name: "Restored profile" } } } }),
      );
      await application.setupPersistence();
      await queryDone.promise;
      expect(fixture.queryTerminals).toEqual(["Query system initialized"]);
      expect(await readPersistedValue("persistent", ["profiles", "restored", "name"])).toBe(
        "Restored profile",
      );
      expect(await readPersistedValue("persistent", ["profiles", "original", "name"])).toBe(
        mode === "restore" ? undefined : "Original profile",
      );
      expect(await readPersistedValue("app", ["extensions", "local-game", "path"])).toBe(
        extensionPath,
      );
      expect(JSON.parse(await readFile(importMarker, "utf8"))).toEqual({
        version: 2,
        source: "/previous/Vortex",
      });
      expect(application.mLevelPersistors).toHaveLength(1);
      expect([...singleton.attachedDatabases.values()]).toEqual([
        path.join(customPath, currentStatePath),
      ]);
      await closeMainPersistence();
      for (const persist of application.mLevelPersistors) await persist.close();
      expect([...singleton.attachedDatabases]).toEqual([]);
      expect(attempts).toEqual([
        { directory: path.join(customPath, currentStatePath), repair: false, settled: true },
      ]);
      vi.restoreAllMocks();
      const reopened = await LevelPersist.create(path.join(customPath, currentStatePath));
      try {
        expect(await reopened.getItem(restoredKey)).toBe(JSON.stringify("Restored profile"));
        expect(await reopened.getItem(extensionKey)).toBe(JSON.stringify(extensionPath));
        if (mode === "restore") {
          await expect(reopened.getItem(originalKey)).rejects.toMatchObject({
            name: "NotFoundError",
          });
        } else {
          expect(await reopened.getItem(originalKey)).toBe(JSON.stringify("Original profile"));
        }
      } finally {
        await reopened.close();
      }
      expect(await readFile(path.join(defaultPath, currentStatePath))).toEqual(invalidDefault);
    } finally {
      if (getMainPersistor() !== undefined) await queryDone.promise;
      await closeMainPersistence();
      for (const persist of application?.mLevelPersistors ?? []) await persist.close();
      vi.restoreAllMocks();
      const remaining = [...singleton.attachedDatabases];
      singleton.close();
      fixture.queryDone = undefined;
      await rm(root, { recursive: true, force: true });
      expect(remaining, "all native database owners detach before cleanup").toEqual([]);
    }
  },
);

it("normalizes existing object rows before startup hydration and descendant persistence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "startup-object-rows-"));
  const dataPath = path.join(root, "user-data");
  fixture.userData = dataPath;
  fixture.appData = path.join(root, "config");
  fixture.mainBase = path.resolve(import.meta.dirname, "../build");
  fixture.queryTerminals = [];
  const queryDone = Promise.withResolvers<void>();
  fixture.queryDone = () => queryDone.resolve();
  let application: PersistenceApplication | undefined;
  try {
    await mkdir(dataPath, { recursive: true });
    const startup = path.join(fixture.appData, "Nyastra fixture");
    await mkdir(startup, { recursive: true });
    await writeFile(path.join(startup, "startup.json"), "{}");
    const seeded = await LevelPersist.create(path.join(dataPath, currentStatePath));
    await seeded.setItem(
      ["persistent", "mods", "skyrimse"],
      '{"retained":{"id":"retained","attributes":{"name":"parent"}}}',
    );
    await seeded.setItem(
      ["persistent", "mods", "skyrimse", "retained", "attributes", "name"],
      '"child override"',
    );
    await seeded.close();
    application = Object.assign(Object.create(Application.prototype), {
      mArgs: parseCommandline(["/fixture/nyastra-mod-manager", "--user-data", dataPath], false),
      mBasePath: dataPath,
      mLevelPersistors: [],
    }) as PersistenceApplication;
    await application.setupPersistence();
    await queryDone.promise;
    expect(fixture.queryTerminals).toEqual(["Query system initialized"]);
    expect(await readPersistedValue("persistent", ["mods", "skyrimse", "retained", "id"])).toBe(
      "retained",
    );
    expect(
      await readPersistedValue("persistent", [
        "mods",
        "skyrimse",
        "retained",
        "attributes",
        "name",
      ]),
    ).toBe("child override");
    const ipc = getMainPersistor()!;
    ipc.applyDiffOperations("persistent", [
      { type: "remove", path: ["mods", "skyrimse", "retained"] },
    ]);
    await ipc.finalizeWrite();
    await closeMainPersistence();
    const reopened = await LevelPersist.create(path.join(dataPath, currentStatePath));
    try {
      expect(await reopened.getAllKVs()).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: ["persistent", "mods", "skyrimse"] }),
          expect.objectContaining({ key: ["persistent", "mods", "skyrimse", "retained", "id"] }),
        ]),
      );
      expect(
        (await reopened.getAllKeys()).some((key) => key[0] === "persistent" && key[1] === "mods"),
      ).toBe(false);
    } finally {
      await reopened.close();
    }
  } finally {
    if (getMainPersistor() !== undefined) await queryDone.promise;
    await closeMainPersistence();
    for (const persist of application?.mLevelPersistors ?? []) await persist.close();
    DuckDBSingleton.getInstance().close();
    fixture.queryDone = undefined;
    await rm(root, { recursive: true, force: true });
  }
});

vi.mock("../../renderer/src/logging", () => ({ log: vi.fn() }));
vi.mock("../../renderer/src/extensions/mod_management/util/testModReference", () => ({
  referenceEqual: () => false,
}));

for (const shape of [
  "normal-mixed",
  "embedded-separator",
  "array-property",
  "bad\uFFFDname",
  "bad\u0001name",
  "bad\ud800name",
]) {
  for (const action of [
    "REMOVE_MOD",
    "UPDATE_ATTRIBUTE",
    "REMOVE_ATTRIBUTE",
    "UPDATE_QUERY_ATTRIBUTE",
    "REPAIR_STARTUP",
    ...(shape === "array-property" ? ["REPLACE_ARRAY"] : []),
  ]) {
    it(`compatible startup ${JSON.stringify(shape)}: ${action}, flush, reopen and second startup`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "startup-compatibility-"));
      const dataPath = path.join(root, "user-data");
      fixture.userData = dataPath;
      fixture.appData = path.join(root, "config");
      fixture.mainBase = path.resolve(import.meta.dirname, "../build");
      let application: PersistenceApplication | undefined;
      let queryDone: Promise<void> | undefined;
      const attribute =
        shape === "embedded-separator"
          ? "embedded###name"
          : shape.startsWith("bad")
            ? shape
            : "obsolete";
      const retained = {
        id: "retained",
        installationPath: "retained",
        state: "installed",
        type: "",
        attributes: {
          name: "parent",
          source: "nexus",
          modId: 10,
          fileId: 20,
          [attribute]: "keep",
          nil: null,
          empty: {},
          tags: ["one", null],
        },
      };
      const sibling = {
        ...retained,
        id: "sibling",
        installationPath: "sibling",
        attributes: { name: "sibling", source: "nexus", modId: 11, fileId: 21 },
      };
      type Mods = Record<string, Record<string, typeof retained>>;
      const modsKey = ["persistent", "mods", "skyrimse"];
      const rows: Array<[string[], string]> = [
        [modsKey, JSON.stringify({ retained, sibling })],
        [[...modsKey, "retained", "attributes", "name"], '"child override"'],
        [["app", "instanceId"], '"synthetic-instance"'],
        [["persistent", "profiles", "p", "gameId"], '"skyrimse"'],
        [["settings", "profiles", "activeProfileId"], '"p"'],
        [["settings", "window", "width"], " 800 "],
        [["persistent", "mods", "skyrimse2", "unrelated"], " [1,null,{}] "],
        [["persistent"], ' {"ignoredHiveRow":true} '],
      ];
      if (shape === "array-property")
        rows.push([[...modsKey, "retained", "attributes", "tags", "custom"], '"extra"']);
      const start = async (repair: boolean) => {
        fixture.queryTerminals = [];
        const done = Promise.withResolvers<void>();
        queryDone = done.promise;
        fixture.queryDone = () => done.resolve();
        application = Object.assign(Object.create(Application.prototype), {
          mArgs: parseCommandline(["/fixture/nyastra-mod-manager", "--user-data", dataPath], false),
          mBasePath: dataPath,
          mLevelPersistors: [],
        }) as PersistenceApplication;
        await application.setupPersistence(repair);
        await queryDone;
        expect(fixture.queryTerminals).toEqual(["Query system initialized"]);
        return application.mLevelPersistors[0]!;
      };
      const stop = async () => {
        await closeMainPersistence();
        for (const persist of application?.mLevelPersistors ?? []) await persist.close();
        application = undefined;
        DuckDBSingleton.getInstance().close();
      };
      try {
        await mkdir(dataPath, { recursive: true });
        const startup = path.join(fixture.appData, "Nyastra fixture");
        await mkdir(startup, { recursive: true });
        await writeFile(path.join(startup, "startup.json"), "{}");
        // Raw rows keep the fixture independent of current write behavior.
        const leveldown = createRequire(import.meta.url)("leveldown") as (directory: string) => {
          open(options: { createIfMissing: boolean }, callback: (error?: Error) => void): void;
          put(key: Buffer, value: Buffer, callback: (error?: Error) => void): void;
          close(callback: (error?: Error) => void): void;
        };
        const raw = leveldown(path.join(dataPath, currentStatePath));
        await new Promise<void>((resolve, reject) =>
          raw.open({ createIfMissing: true }, (error?: Error) =>
            error ? reject(error) : resolve(),
          ),
        );
        try {
          for (const [key, value] of rows)
            await new Promise<void>((resolve, reject) =>
              raw.put(Buffer.from(key.join("###")), Buffer.from(value), (error?: Error) =>
                error ? reject(error) : resolve(),
              ),
            );
        } finally {
          await new Promise<void>((resolve, reject) =>
            raw.close((error?: Error) => (error ? reject(error) : resolve())),
          );
        }
        let persist = await start(action === "REPAIR_STARTUP");
        const renderer = path.resolve(import.meta.dirname, "../../renderer/src");
        type RendererPersistence = {
          createPersistDiffMiddleware(
            getApi: () => { sendDiff: (hive: string, operations: DiffOperation[]) => void },
          ): Middleware;
          flushPendingDiffsSync(): void;
        };
        const middleware = (await import(
          path.join(renderer, "store/persistDiffMiddleware.ts")
        )) as RendererPersistence;
        const { modsReducer } = (await import(
          path.join(renderer, "extensions/mod_management/reducers/mods.ts")
        )) as {
          modsReducer: { reducers: Record<string, (state: unknown, payload: unknown) => unknown> };
        };
        const hydrated = await readHiveData("persistent");
        const expectedInitial = {
          ...retained,
          attributes: { ...retained.attributes, name: "child override" },
        };
        if (shape === "array-property")
          Object.defineProperty(expectedInitial.attributes.tags, "custom", {
            value: "extra",
            enumerable: true,
            writable: true,
            configurable: true,
          });
        expect((hydrated.mods as Mods).skyrimse!.retained).toEqual(expectedInitial);
        expect(
          await readPersistedValue("persistent", [
            "mods",
            "skyrimse",
            "retained",
            "attributes",
            attribute,
          ]),
        ).toBe("keep");
        const query = async () => {
          const sql = (await import("./store/queryParser"))
            .parseAllQueries(path.join(fixture.mainBase, "queries"), persist.alias)
            .find((q) => q.name === "active_profile_nexus_files")!.sql;
          return getDatabase()!.query<{ vortex_mod_id: string; file_id: string }>(sql);
        };
        expect((await query()).map((row) => row.vortex_mod_id).sort()).toEqual([
          "retained",
          "sibling",
        ]);
        const ipc = getMainPersistor()!;
        const reducer: Reducer<{ persistent: Record<string, unknown> }, { type: string }> = (
          state = { persistent: hydrated },
          input,
        ) => {
          const type =
            input.type === "REMOVE_MOD"
              ? "REMOVE_MOD"
              : [
                    "UPDATE_ATTRIBUTE",
                    "REMOVE_ATTRIBUTE",
                    "UPDATE_QUERY_ATTRIBUTE",
                    "REPLACE_ARRAY",
                  ].includes(input.type)
                ? "SET_MOD_ATTRIBUTE"
                : undefined;
          if (!type) return state;
          return {
            persistent: {
              ...state.persistent,
              mods: modsReducer.reducers[type]!(state.persistent.mods, {
                gameId: "skyrimse",
                modId: "retained",
                attribute:
                  input.type === "UPDATE_QUERY_ATTRIBUTE"
                    ? "fileId"
                    : input.type === "REPLACE_ARRAY"
                      ? "tags"
                      : attribute,
                value:
                  input.type === "REMOVE_ATTRIBUTE"
                    ? undefined
                    : input.type === "UPDATE_QUERY_ATTRIBUTE"
                      ? 24
                      : input.type === "REPLACE_ARRAY"
                        ? ["two"]
                        : "updated",
              }),
            },
          };
        };
        const store = createStore(
          reducer,
          applyMiddleware(
            middleware.createPersistDiffMiddleware(() => ({
              sendDiff: (hive, operations) => ipc.applyDiffOperations(hive, operations),
            })),
          ),
        );
        store.dispatch({ type: "INIT" });
        store.dispatch({ type: action });
        middleware.flushPendingDiffsSync();
        await ipc.finalizeWrite();
        const expected = store.getState().persistent;
        expect(await readHiveData("persistent")).toEqual(expected);
        expect((await query()).map((row) => row.vortex_mod_id).sort()).toEqual(
          action === "REMOVE_MOD" ? ["sibling"] : ["retained", "sibling"],
        );
        if (action === "UPDATE_QUERY_ATTRIBUTE")
          expect((await query()).find((row) => row.vortex_mod_id === "retained")!.file_id).toBe(
            "24",
          );
        await stop();
        const reopened = await LevelPersist.create(path.join(dataPath, currentStatePath));
        try {
          expect(await reopened.getItem(["settings", "window", "width"])).toBe(" 800 ");
          expect(await reopened.getItem(["persistent", "mods", "skyrimse2", "unrelated"])).toBe(
            " [1,null,{}] ",
          );
          expect(await reopened.getItem(["persistent"])).toBe(' {"ignoredHiveRow":true} ');
        } finally {
          await reopened.close();
        }
        persist = await start(true);
        expect(await readHiveData("persistent")).toEqual(expected);
        // A second update exercises the representation produced by the first write.
        await writePersistedValue(
          "persistent",
          ["mods", "skyrimse", "sibling", "attributes", "fileId"],
          22,
        );
        const expectedSecond = {
          ...expected,
          mods: {
            ...(expected.mods as Mods),
            skyrimse: {
              ...(expected.mods as Mods).skyrimse,
              sibling: { ...sibling, attributes: { ...sibling.attributes, fileId: 22 } },
            },
          },
        };
        expect(await readHiveData("persistent")).toEqual(expectedSecond);
        expect((await query()).find((row) => row.vortex_mod_id === "sibling")!.file_id).toBe("22");
        await stop();
        await start(false);
        expect(await readHiveData("persistent")).toEqual(expectedSecond);
      } finally {
        if (getMainPersistor() !== undefined) await queryDone;
        await stop();
        fixture.queryDone = undefined;
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

it("command-line reads and removals reach values held only in ancestor JSON rows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ancestor-cli-"));
  const dbPath = path.join(root, currentStatePath);
  fixture.mainBase = path.resolve(import.meta.dirname, "../build");
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const application = Object.create(Application.prototype) as {
    handleGet(paths: string[], directory: string): Promise<void>;
    handleDel(paths: string[], directory: string): Promise<void>;
  };
  try {
    const persist = await LevelPersist.create(dbPath);
    await persist.setItem(
      ["persistent", "mods", "skyrimse"],
      '{"retained":{"id":"retained"},"healthy":{"id":"healthy"}}',
    );
    await persist.close();
    await application.handleGet(["persistent.mods.skyrimse.retained"], dbPath);
    expect(output).toHaveBeenCalledWith('persistent.mods.skyrimse.retained = {"id":"retained"}\n');
    await application.handleDel(["persistent.mods.skyrimse.retained"], dbPath);
    expect(errors).not.toHaveBeenCalled();
    const reopened = await LevelPersist.create(dbPath);
    try {
      expect(await reopened.readStateValue(["persistent", "mods", "skyrimse"])).toEqual({
        healthy: { id: "healthy" },
      });
    } finally {
      await reopened.close();
    }
  } finally {
    vi.restoreAllMocks();
    DuckDBSingleton.getInstance().close();
    await rm(root, { recursive: true, force: true });
  }
});
