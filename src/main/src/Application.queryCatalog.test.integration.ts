import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { IParameters } from "@vortex/shared/cli";
import * as sharedErrors from "@vortex/shared/errors";
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

import type LevelPersist from "./store/LevelPersist";

type StartupApplication = {
  mArgs: IParameters;
  mLevelPersistors: LevelPersist[];
  regularStartInner(args: IParameters): Promise<void>;
};

function savedRows(label: string): Array<{ key: string[]; value: string }> {
  const rows: Array<{ key: string[]; value: string }> = [];
  const add = (key: string[], value: string | number) => {
    rows.push({ key, value: JSON.stringify(value) });
  };
  for (const [id, game, activated] of [
    ["active", "a", 300],
    ["recent", "b", 600],
    ["older", "c", 100],
  ] as const) {
    const prefix = ["persistent", "profiles", id];
    add([...prefix, "name"], `${label} ${id}`);
    add([...prefix, "gameId"], `${label}-${game}`);
    add([...prefix, "lastActivated"], activated);
  }
  add(["settings", "profiles", "activeProfileId"], "active");
  for (const mod of [
    { id: "mapped", game: "a", source: "nexus", state: "installed", modId: 101, fileId: 1001 },
    { id: "fallback", game: "a", source: "nexus", state: "installed", modId: 102, fileId: 1002 },
    { id: "downloaded", game: "a", source: "nexus", state: "downloaded", modId: 103, fileId: 1003 },
    { id: "foreign", game: "a", source: "other", state: "installed", modId: 104, fileId: 1004 },
    { id: "other-game", game: "b", source: "nexus", state: "installed", modId: 105, fileId: 1005 },
  ]) {
    const prefix = ["persistent", "mods", `${label}-${mod.game}`, mod.id];
    add([...prefix, "state"], mod.state);
    for (const attribute of ["source", "modId", "fileId"] as const) {
      add([...prefix, "attributes", attribute], mod[attribute]);
    }
    if (mod.id === "mapped") add([...prefix, "attributes", "downloadGame"], `${label}-mapped`);
  }
  return rows;
}

it.each(["cold", "native lock retry", "Continue recovery", "lock retry beside another owner"])(
  "initializes shipped query results for %s",
  async (mode) => {
    // Retain the real error class while reloading main persistence state.
    vi.doMock("../../shared/src/errors/base", () => sharedErrors);
    vi.resetModules();
    const { default: Application } = await import("./Application");
    const { parseCommandline } = await import("./cli");
    const { default: DuckDBSingleton } = await import("./store/DuckDBSingleton");
    const { default: LevelPersist } = await import("./store/LevelPersist");
    const { default: QueryRegistry } = await import("./store/QueryRegistry");
    const { parseAllQueries } = await import("./store/queryParser");
    const persistence = await import("./store/mainPersistence");
    const initiallyAvailable = persistence.getDatabase() !== undefined;
    const root = await mkdtemp(path.join(tmpdir(), "query-catalog-"));
    const data = path.join(root, "data");
    const config = path.join(root, "config");
    const statePath = path.join(data, currentStatePath);
    const otherPath = path.join(root, "other", currentStatePath);
    const backup = path.join(root, "backup.json");
    const rows = savedRows("Selected");
    const otherRows = savedRows("Other");
    const lockRetry = mode.includes("lock retry");
    const withOtherOwner = mode === "lock retry beside another owner";
    const recovery = mode === "Continue recovery";
    const done = Promise.withResolvers<void>();
    const stop = new Error("stop before Electron UI");
    let singleton = DuckDBSingleton.getInstance();
    let application: StartupApplication | undefined;
    let other: LevelPersist | undefined;
    let holder: DuckDBInstance | undefined;
    let held: DuckDBConnection | undefined;
    let startupError: unknown;
    const queryErrors: unknown[] = [];
    let databaseAvailable: boolean;
    let selectedAlias: string | undefined;
    let profileRows: unknown;
    let recentGames: unknown;
    let alternateGames: unknown;
    let nexusFiles: unknown;
    let otherProfiles: unknown;
    let reopenedRows: unknown;
    let reopenedMerge: unknown;
    let reopenedOther: unknown;
    let terminals: string[];
    let ownersAfterSelectedClose: Array<[string, string]>;
    let remaining: Array<[string, string]>;
    const dialogs: unknown[] = [];
    const attempts: Array<{ directory: string; alias: string; settled: boolean; error?: string }> =
      [];
    const assets: Array<{ source: Buffer; built: Buffer }> = [];
    let lockFailures = 0;
    fixture.mainBase = path.resolve(import.meta.dirname, "../build");
    fixture.userData = data;
    fixture.appData = config;
    fixture.queryTerminals = [];
    fixture.queryDone = () => done.resolve();
    vi.clearAllMocks();

    const releaseHolder = async () => {
      if (held !== undefined) {
        await held.run("DETACH held");
        held.closeSync();
        held = undefined;
      }
      holder?.closeSync();
      holder = undefined;
    };
    const observeQuery = async (run: () => Promise<unknown>) => {
      try {
        return await run();
      } catch (error) {
        queryErrors.push(error);
        return undefined;
      }
    };

    try {
      await mkdir(data, { recursive: true });
      await mkdir(path.join(root, "other"), { recursive: true });
      await mkdir(path.join(config, "Nyastra fixture"), { recursive: true });
      await writeFile(path.join(config, "Nyastra fixture", "startup.json"), "{}");
      for (const relative of [
        "setup/tables.sql",
        "select/profiles.sql",
        "select/nexus_files.sql",
      ]) {
        assets.push({
          source: await readFile(path.resolve(import.meta.dirname, "../../queries", relative)),
          built: await readFile(path.join(fixture.mainBase, "queries", relative)),
        });
      }
      const seed = await LevelPersist.create(statePath);
      try {
        await seed.bulkSetItem(rows);
      } finally {
        await seed.close();
      }
      singleton.close();
      singleton = DuckDBSingleton.getInstance();
      if (withOtherOwner) {
        other = await LevelPersist.create(otherPath);
        await other.bulkSetItem(otherRows);
        const otherRegistry = new QueryRegistry(await singleton.createConnection());
        await otherRegistry.initialize(
          parseAllQueries(path.join(fixture.mainBase, "queries"), other.alias),
        );
      }
      if (lockRetry) {
        holder = await DuckDBInstance.create(":memory:", {
          allow_unsigned_extensions: "true",
          extension_directory: path.join(fixture.mainBase, "duckdb-extensions"),
        });
        held = await holder.connect();
        await held.run("LOAD level_pivot");
        await held.run(`ATTACH '${statePath.replaceAll("'", "''")}' AS held (TYPE level_pivot)`);
      }
      const attach = singleton.attachDatabase.bind(singleton);
      vi.spyOn(singleton, "attachDatabase").mockImplementation(async (directory, alias) => {
        const attempt: (typeof attempts)[number] = { directory, alias, settled: false };
        attempts.push(attempt);
        try {
          return await attach(directory, alias);
        } catch (error) {
          attempt.error = error instanceof Error ? error.message : String(error);
          if (held !== undefined) {
            // Release only after the original native attach fails on the held lock.
            lockFailures++;
            await releaseHolder();
          }
          throw error;
        } finally {
          attempt.settled = true;
        }
      });
      const initialize = vi.spyOn(QueryRegistry.prototype, "initialize");
      if (recovery) await writeFile(backup, "invalid JSON backup");
      const args = parseCommandline(
        [
          "/fixture/nyastra-mod-manager",
          "--start-minimized",
          ...(recovery ? ["--merge", backup] : []),
        ],
        false,
      );
      args.startMinimized = true;
      application = Object.assign(Object.create(Application.prototype), {
        mArgs: args,
        mBasePath: data,
        mLevelPersistors: [],
        validateFiles: async () => {},
        showDialog: async (options: unknown) => {
          dialogs.push(options);
          // Correct the backup at Continue. This does not simulate corrupt-database repair.
          await writeFile(
            backup,
            JSON.stringify({ persistent: { profiles: { merged: { name: "Merged" } } } }),
          );
        },
        identifyInstallType: () => {},
        migrateIfNecessary: async () => {},
        initDevel: async () => {
          await done.promise;
          throw stop;
        },
      }) as StartupApplication;
      try {
        await application.regularStartInner(args);
      } catch (error) {
        startupError = error;
      }
      if (persistence.getMainPersistor() !== undefined) await done.promise;
      const initialization = initialize.mock.results[0];
      if (initialization?.type === "return") await observeQuery(() => initialization.value);
      terminals = [...fixture.queryTerminals];
      selectedAlias = application.mLevelPersistors[0]?.alias;
      const database = persistence.getDatabase();
      databaseAvailable = database !== undefined;
      if (database !== undefined) {
        profileRows = await observeQuery(() =>
          database.query(
            `SELECT profile_id, name FROM "${selectedAlias}".profiles_pivot ORDER BY profile_id`,
          ),
        );
      }
      const initializedRegistry = initialize.mock.contexts[0];
      if (initializedRegistry instanceof QueryRegistry) {
        recentGames = await observeQuery(() =>
          initializedRegistry.executeQuery("recently_managed_games", {
            current_game_id: "Selected-a",
          }),
        );
        alternateGames = await observeQuery(() =>
          initializedRegistry.executeQuery("recently_managed_games", {
            current_game_id: "Selected-b",
          }),
        );
        nexusFiles = await observeQuery(() =>
          initializedRegistry.executeQuery("active_profile_nexus_files"),
        );
      }
      if (other !== undefined) {
        otherProfiles = (
          await other.connection.runAndReadAll(
            `SELECT profile_id, name FROM "${other.alias}".profiles_pivot ORDER BY profile_id`,
          )
        ).getRowObjectsJson();
      }
      await persistence.finalizeMainWrite();
      await persistence.closeMainPersistence();
      for (const persist of application.mLevelPersistors) await persist.close();
      ownersAfterSelectedClose = [...singleton.attachedDatabases];
      await other?.close();
      vi.restoreAllMocks();
      singleton.close();
      singleton = DuckDBSingleton.getInstance();
      const reopened = await LevelPersist.create(statePath);
      try {
        reopenedRows = await Promise.all(rows.map(({ key }) => reopened.getItem(key)));
        if (recovery)
          reopenedMerge = await reopened.getItem(["persistent", "profiles", "merged", "name"]);
      } finally {
        await reopened.close();
      }
      if (withOtherOwner) {
        const reopenedOwner = await LevelPersist.create(otherPath);
        try {
          reopenedOther = await Promise.all(otherRows.map(({ key }) => reopenedOwner.getItem(key)));
        } finally {
          await reopenedOwner.close();
        }
      }
    } finally {
      if (persistence.getMainPersistor() !== undefined) await done.promise;
      await persistence.closeMainPersistence();
      for (const persist of application?.mLevelPersistors ?? []) await persist.close();
      await other?.close();
      await releaseHolder();
      vi.restoreAllMocks();
      remaining = [...singleton.attachedDatabases];
      singleton.close();
      fixture.queryDone = undefined;
      await rm(root, { recursive: true, force: true });
    }

    expect(remaining, "native owners detach before cleanup").toEqual([]);
    expect(attempts.every(({ settled }) => settled)).toBe(true);
    expect(startupError).toBe(stop);
    expect(initiallyAvailable, "each case imports fresh main persistence").toBe(false);
    expect.soft(databaseAvailable).toBe(true);
    expect.soft(terminals).toEqual(["Query system initialized"]);
    expect.soft(queryErrors).toEqual([]);
    expect
      .soft(profileRows)
      .toEqual([
        { profile_id: "active", name: "Selected active" },
        ...(recovery ? [{ profile_id: "merged", name: "Merged" }] : []),
        { profile_id: "older", name: "Selected older" },
        { profile_id: "recent", name: "Selected recent" },
      ]);
    expect.soft(recentGames).toEqual([{ game_id: "Selected-b" }, { game_id: "Selected-c" }]);
    expect.soft(alternateGames).toEqual([{ game_id: "Selected-a" }, { game_id: "Selected-c" }]);
    expect.soft(nexusFiles).toEqual([
      { game_id: "Selected-a", mod_id: "102", file_id: "1002", vortex_mod_id: "fallback" },
      { game_id: "Selected-mapped", mod_id: "101", file_id: "1001", vortex_mod_id: "mapped" },
    ]);
    expect(reopenedRows).toEqual(rows.map(({ value }) => value));
    expect(reopenedMerge).toBe(recovery ? JSON.stringify("Merged") : undefined);
    expect(dialogs).toMatchObject(
      recovery ? [{ message: "Data corrupted", buttons: ["Continue"] }] : [],
    );
    expect(lockFailures).toBe(lockRetry ? 1 : 0);
    expect(attempts.map(({ alias }) => alias)).toEqual(
      withOtherOwner ? ["db_1", "db_2"] : mode === "cold" ? ["db"] : ["db", "db_1"],
    );
    expect(selectedAlias).toBe(withOtherOwner ? "db_2" : mode === "cold" ? "db" : "db_1");
    expect(attempts.map(({ directory }) => directory)).toEqual(attempts.map(() => statePath));
    expect(attempts.flatMap(({ error }) => (error === undefined ? [] : [error]))).toEqual(
      lockRetry
        ? [expect.stringMatching(/lock .*already held|resource (temporarily )?unavailable/i)]
        : [],
    );
    expect(ownersAfterSelectedClose).toEqual(withOtherOwner ? [["db", otherPath]] : []);
    expect(otherProfiles).toEqual(
      withOtherOwner
        ? [
            { profile_id: "active", name: "Other active" },
            { profile_id: "older", name: "Other older" },
            { profile_id: "recent", name: "Other recent" },
          ]
        : undefined,
    );
    expect(reopenedOther).toEqual(withOtherOwner ? otherRows.map(({ value }) => value) : undefined);
    for (const { source, built } of assets) expect(built).toEqual(source);
    expect(assets).toHaveLength(3);
  },
);

it("quotes internal catalog literals and identifiers for native queries", async () => {
  const { parseAllQueries } = await import("./store/queryParser");
  const { default: QueryRegistry } = await import("./store/QueryRegistry");
  const root = await mkdtemp(path.join(tmpdir(), "query-quotes-"));
  const alias = `catalog'"$&`;
  const identifier = `"${alias.replaceAll('"', '""')}"`;
  const value = `exact '"$& bytes`;
  const instance = await DuckDBInstance.create(":memory:", {
    allow_unsigned_extensions: "true",
    extension_directory: path.resolve(import.meta.dirname, "../build/duckdb-extensions"),
  });
  const connection = await instance.connect();
  let result: unknown;
  try {
    await writeFile(
      path.join(root, "setup.sql"),
      [
        "-- @type setup",
        "-- @name quoted_kv",
        "CALL level_pivot_create_table({{persistor_catalog_literal}}, 'quoted_kv', NULL, ['key', 'value'], table_mode := 'raw');",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "select.sql"),
      [
        "-- @type select",
        "-- @name quoted_value",
        "-- @param key VARCHAR",
        "SELECT value FROM {{persistor_catalog}}.quoted_kv WHERE key = $key;",
      ].join("\n"),
    );
    await connection.run("LOAD level_pivot");
    await connection.run(
      `ATTACH '${path.join(root, "state").replaceAll("'", "''")}' AS ${identifier} (TYPE level_pivot, CREATE_IF_MISSING true)`,
    );
    const registry = new QueryRegistry(connection);
    await registry.initialize(parseAllQueries(root, alias));
    await connection.run(`INSERT INTO ${identifier}.quoted_kv VALUES ($1, $2)`, ["exact", value]);
    result = await registry.executeQuery("quoted_value", { key: "exact" });
    await connection.run(`DETACH ${identifier}`);
  } finally {
    connection.closeSync();
    instance.closeSync();
    await rm(root, { recursive: true, force: true });
  }
  expect(result).toEqual([{ value }]);
});
