import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { IParameters } from "@vortex/shared/cli";
import { currentStatePath } from "@vortex/shared/state";
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
