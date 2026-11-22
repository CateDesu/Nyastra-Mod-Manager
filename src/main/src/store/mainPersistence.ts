import * as path from "node:path";

import { getErrorMessageOrDefault } from "@vortex/shared";
import type { DiffOperation, Serializable } from "@vortex/shared/ipc";
import type { PersistedHive } from "@vortex/shared/state";
import { BrowserWindow } from "electron";

import { getVortexPath } from "../getVortexPath";
import { betterIpcMain } from "../ipc";
import { log } from "../logging";
import { Database } from "./Database";
import DuckDBSingleton from "./DuckDBSingleton";
import type LevelPersist from "./LevelPersist";
import { setupPersistenceIPC } from "./persistenceIPC";
import QueryInvalidator from "./QueryInvalidator";
import type { ParsedQuery } from "./queryParser";
import { parseAllQueries } from "./queryParser";
import QueryRegistry from "./QueryRegistry";
import QueryWatcher from "./QueryWatcher";
import ReduxPersistorIPC from "./ReduxPersistorIPC";
import SubPersistor from "./SubPersistor";

let mainPersistor: ReduxPersistorIPC | undefined;
let levelPersist: LevelPersist | undefined;
let queryRegistry: QueryRegistry | undefined;
let queryInvalidator: QueryInvalidator | undefined;
let database: Database | undefined;

/** Available once query initialization completes. */
export function getDatabase(): Database | undefined {
  return database;
}

export function initMainPersistence(levelPersistor: LevelPersist): ReduxPersistorIPC {
  if (mainPersistor !== undefined) {
    return mainPersistor;
  }

  levelPersist = levelPersistor;
  mainPersistor = new ReduxPersistorIPC();
  mainPersistor.setQueryInvalidator(levelPersistor);

  mainPersistor.setPersistorFactory((hive: string) => {
    if (levelPersist === undefined) {
      return undefined;
    }
    return new SubPersistor(levelPersist, hive);
  });

  setupPersistenceIPC(mainPersistor);

  initQuerySystem(levelPersistor).catch((err) => {
    log("warn", "Failed to initialize query system", {
      error: getErrorMessageOrDefault(err),
    });
  });

  return mainPersistor;
}

async function initQuerySystem(levelPersistor: LevelPersist): Promise<void> {
  const singleton = DuckDBSingleton.getInstance();
  if (!singleton.isInitialized) {
    log("warn", "DuckDBSingleton not initialized, skipping query system");
    return;
  }

  const queryConnection = await singleton.createConnection();

  const queriesDir = path.join(getVortexPath("base"), "queries");
  let queries: ParsedQuery[];
  try {
    queries = parseAllQueries(queriesDir, levelPersistor.alias);
  } catch (err) {
    log("warn", "No query files found or parse error", {
      dir: queriesDir,
      error: getErrorMessageOrDefault(err),
    });
    return;
  }

  if (queries.length === 0) {
    log("debug", "No queries found, skipping query system initialization");
    return;
  }

  queryRegistry = new QueryRegistry(queryConnection);
  await queryRegistry.initialize(queries);

  queryInvalidator = new QueryInvalidator(queryRegistry);
  mainPersistor?.setQueryInvalidator(levelPersistor, queryInvalidator);

  database = new Database(levelPersistor, queryInvalidator);

  const queryWatcher = new QueryWatcher(queryRegistry);
  queryInvalidator.setWatcher(queryWatcher);

  log("info", "Query system initialized", {
    queryCount: queryRegistry.getQueryNames().length,
  });
}

/** Register a hive and return its hydration data. */
export function registerHive(hive: string): Promise<{ [key: string]: Serializable }> {
  if (mainPersistor === undefined || levelPersist === undefined) {
    return Promise.reject(
      new Error("Main persistence not initialized. Call initMainPersistence() first."),
    );
  }

  const subPersistor = new SubPersistor(levelPersist, hive);
  return mainPersistor.insertPersistor(hive, subPersistor);
}

export function getMainPersistor(): ReduxPersistorIPC | undefined {
  return mainPersistor;
}

/** Persist main-process changes and notify renderers without a persistence feedback loop. */
export async function pushStateToRenderer(
  hive: PersistedHive,
  operations: DiffOperation[],
): Promise<void> {
  if (mainPersistor === undefined || levelPersist === undefined) {
    log("warn", "pushStateToRenderer called before persistence is initialized");
    return;
  }

  mainPersistor.applyDiffOperations(hive, operations);
  // Persist before notifying renderers.
  await mainPersistor.finalizeWrite();

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      betterIpcMain.send(win.webContents, "persist:push", hive, operations);
    }
  }
}

export function finalizeMainWrite(): Promise<void> {
  if (mainPersistor === undefined) {
    return Promise.resolve();
  }
  return mainPersistor.finalizeWrite();
}

export async function closeMainPersistence(): Promise<void> {
  if (mainPersistor !== undefined) {
    await mainPersistor.finalizeWrite();
  }
  if (levelPersist !== undefined) {
    await levelPersist.close();
  }
  mainPersistor = undefined;
  levelPersist = undefined;
}

export async function readPersistedValue<T>(hive: string, path: string[]): Promise<T | undefined> {
  if (levelPersist === undefined) {
    return undefined;
  }

  try {
    return (await levelPersist.readStateValue([hive, ...path])) as T | undefined;
  } catch (err) {
    log("warn", "Could not read persisted value", {
      hive,
      path,
      error: getErrorMessageOrDefault(err),
    });
    return undefined;
  }
}

export async function writePersistedValue<T>(
  hive: string,
  path: string[],
  value: T,
): Promise<void> {
  if (levelPersist === undefined) {
    return;
  }

  try {
    const subPersistor = new SubPersistor(levelPersist, hive);
    const dirtyTables = await levelPersist.withTransaction(async () => {
      await subPersistor.setItem(path, JSON.stringify(value));
      return levelPersist!.getDirtyTables();
    });
    if (dirtyTables.length > 0) queryInvalidator?.notifyDirtyTables(dirtyTables);
  } catch (err) {
    const message = getErrorMessageOrDefault(err);
    log("warn", "Could not write persisted value", {
      hive,
      path,
      error: message,
    });
  }
}

export async function readHiveData(hive: string): Promise<{ [key: string]: Serializable }> {
  if (mainPersistor === undefined || levelPersist === undefined) {
    return {};
  }

  const persistor = mainPersistor;
  try {
    const subPersistor = new SubPersistor(levelPersist, hive);
    return await persistor.insertPersistor(hive, subPersistor);
  } catch (err) {
    const message = getErrorMessageOrDefault(err);
    log("warn", "Could not read hive data", { hive, error: message });
    return {};
  }
}

export async function getPersistedHives(): Promise<string[]> {
  if (levelPersist === undefined) {
    return [];
  }

  try {
    return await levelPersist.getPersistedHives();
  } catch (err) {
    const message = getErrorMessageOrDefault(err);
    log("warn", "Could not get persisted hives", { error: message });
    return [];
  }
}

export async function registerAllPersistedHives(): Promise<{
  [hive: string]: Serializable;
}> {
  if (mainPersistor === undefined || levelPersist === undefined) {
    return {};
  }

  const persistence = levelPersist;
  const redux = mainPersistor;
  return persistence.withSerializedRead(async () => {
    const hives = await getPersistedHives();
    log("info", "Discovered persisted hives", { hives });

    const result: { [hive: string]: Serializable } = {};

    for (const hive of hives) {
      try {
        const subPersistor = new SubPersistor(persistence, hive);
        result[hive] = await redux.insertPersistor(hive, subPersistor);
      } catch (err) {
        const message = getErrorMessageOrDefault(err);
        log("warn", "Could not register hive", { hive, error: message });
        result[hive] = {};
      }
    }

    return result;
  });
}
