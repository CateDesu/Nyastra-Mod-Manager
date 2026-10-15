import { unknownToError } from "@vortex/shared";
import type { DiffOperation, Serializable } from "@vortex/shared/ipc";
import type { IPersistor, PersistorKey } from "@vortex/shared/state";

import { terminate } from "../errorHandling";
import { log } from "../logging";
import type LevelPersist from "./LevelPersist";
import type QueryInvalidator from "./QueryInvalidator";
import { insertStateValue } from "./stateTree";

function insertValueAtLeaf<T extends Record<string, unknown>, V>(
  target: T,
  key: string[],
  value: V,
  hive: string,
) {
  try {
    insertStateValue(target, key, value);
  } catch (err) {
    const newErr = new Error(`Failed to load application state ${hive}.${key.join(".")}`);
    if (err instanceof Error) {
      newErr.stack = err.stack;
    }
    throw newErr;
  }
}

export type PersistorFactory = (hive: string) => IPersistor | undefined;

/** Persist renderer diffs and supply startup state. */
class ReduxPersistorIPC {
  private mPersistors: { [hive: string]: IPersistor } = {};
  private mUpdateQueue: Promise<void> = Promise.resolve();
  private mPersistorFactory: PersistorFactory | undefined;
  #mLevelPersist: LevelPersist | undefined;
  #mInvalidator: QueryInvalidator | undefined;

  constructor() {}

  public setQueryInvalidator(levelPersist: LevelPersist, invalidator: QueryInvalidator): void {
    this.#mLevelPersist = levelPersist;
    this.#mInvalidator = invalidator;
  }

  public setPersistorFactory(factory: PersistorFactory): void {
    this.mPersistorFactory = factory;
  }

  public finalizeWrite(): Promise<void> {
    return this.mUpdateQueue;
  }

  /** Register a persistor and return its hydration data. */
  public insertPersistor(
    hive: string,
    persistor: IPersistor,
  ): Promise<{ [key: string]: Serializable }> {
    return this.loadHydrationData(hive, persistor).then((data) => {
      this.mPersistors[hive] = persistor;
      persistor.setResetCallback(() =>
        this.loadHydrationData(hive, persistor).then(() => undefined),
      );
      return data;
    });
  }

  public async getAllHydrationData(): Promise<{
    [hive: string]: Serializable;
  }> {
    const result: { [hive: string]: Serializable } = {};

    for (const [hive, persistor] of Object.entries(this.mPersistors)) {
      try {
        result[hive] = await this.loadHydrationData(hive, persistor);
      } catch (err) {
        log("error", "Failed to load hydration data for hive", {
          hive,
          error: err,
        });
        result[hive] = {};
      }
    }

    return result;
  }

  public applyDiffOperations(hive: string, operations: DiffOperation[]): void {
    let persistor = this.mPersistors[hive];

    if (persistor === undefined && this.mPersistorFactory !== undefined) {
      const newPersistor = this.mPersistorFactory(hive);
      if (newPersistor !== undefined) {
        log("info", "Created persistor on demand for hive", { hive });
        this.mPersistors[hive] = newPersistor;
        persistor = newPersistor;
      }
    }

    if (persistor === undefined) {
      log("warn", "Received diff for unknown hive (no factory available)", {
        hive,
      });
      return;
    }

    this.mUpdateQueue = this.mUpdateQueue
      .then(() => this.processOperations(hive, persistor, operations))
      .catch((unknownError) => {
        // Recover so later diffs still run.
        const err = unknownToError(unknownError);
        log("error", "Failed to process persistence operations", {
          hive,
          error: err.message,
        });
      });
  }

  // Limit SQL parameters and the work lost when a batch fails.
  private static readonly BULK_CHUNK_SIZE = 256;

  /** Coalesce only consecutive operations to preserve set/remove ordering. */
  private async processOperations(
    hive: string,
    persistor: IPersistor,
    operations: DiffOperation[],
  ): Promise<void> {
    const levelPersist = this.#mLevelPersist;
    const invalidator = this.#mInvalidator;
    const useTransaction = levelPersist !== undefined && invalidator !== undefined;

    try {
      if (useTransaction) {
        await levelPersist.beginTransaction();
      }

      await this.applyOperationsInRuns(persistor, operations);

      if (useTransaction) {
        // Read while the transaction is active and notify only after commit.
        const dirtyTables = await levelPersist.getDirtyTables();
        await levelPersist.commitTransaction();

        if (dirtyTables.length > 0) {
          invalidator.notifyDirtyTables(dirtyTables);
        }
      }
    } catch (unknownError) {
      if (useTransaction) {
        try {
          await levelPersist.rollbackTransaction();
        } catch (rollbackErr) {
          log("warn", "Failed to rollback transaction", {
            error: unknownToError(rollbackErr).message,
          });
        }
      }

      const err = unknownToError(unknownError);

      // Handle disk full error (covers LevelDB and DuckDB/OS-level patterns)
      const diskFullPattern =
        /IO error: .*Append: cannot write|no space left on device|disk full|not enough space/i;
      if (
        diskFullPattern.test(err.message) ||
        (err.stack !== undefined && diskFullPattern.test(err.stack))
      ) {
        terminate(
          new Error(
            "There is not enough space on the disk. Vortex needs to quit now to " +
              "ensure you're not losing further work. Please free up some space, " +
              "then restart Vortex.",
          ),
        );
        // Retry on user ignore
        return this.processOperations(hive, persistor, operations);
      } else {
        terminate(new Error(`Failed to store application state: ${err.message}`));
      }
    }
  }

  private async applyOperationsInRuns(
    persistor: IPersistor,
    operations: DiffOperation[],
  ): Promise<void> {
    let i = 0;
    while (i < operations.length) {
      const op = operations[i];
      if (op === undefined) break;
      const opType = op.type;
      let runEnd = i + 1;
      while (runEnd < operations.length && operations[runEnd]?.type === opType) {
        runEnd++;
      }
      const run = operations.slice(i, runEnd);
      if (opType === "set") {
        await this.applySetRun(persistor, run);
      } else {
        await this.applyRemoveRun(persistor, run);
      }
      i = runEnd;
    }
  }

  private async applySetRun(persistor: IPersistor, run: DiffOperation[]): Promise<void> {
    if (persistor.bulkSetItem !== undefined) {
      for (let start = 0; start < run.length; start += ReduxPersistorIPC.BULK_CHUNK_SIZE) {
        const chunk = run.slice(start, start + ReduxPersistorIPC.BULK_CHUNK_SIZE);
        await persistor.bulkSetItem(
          chunk.map((op) => ({
            key: op.path,
            value: this.serialize(op.value),
          })),
        );
      }
    } else {
      for (const op of run) {
        await persistor.setItem(op.path, this.serialize(op.value));
      }
    }
  }

  private async applyRemoveRun(persistor: IPersistor, run: DiffOperation[]): Promise<void> {
    if (persistor.bulkRemoveItem !== undefined) {
      for (let start = 0; start < run.length; start += ReduxPersistorIPC.BULK_CHUNK_SIZE) {
        const chunk = run.slice(start, start + ReduxPersistorIPC.BULK_CHUNK_SIZE);
        await persistor.bulkRemoveItem(chunk.map((op) => op.path));
      }
    } else {
      for (const op of run) {
        await persistor.removeItem(op.path);
      }
    }
  }

  private async loadHydrationData(
    hive: string,
    persistor: IPersistor,
  ): Promise<{ [key: string]: Serializable }> {
    let kvPairs: Array<{ key: PersistorKey; value: Serializable }>;

    if (persistor.getAllKVs !== undefined) {
      const allKvs = await persistor.getAllKVs();
      kvPairs = allKvs.map((kv: { key: PersistorKey; value: string }) => ({
        key: kv.key,
        value: this.deserialize(kv.value),
      }));
    } else {
      const keys = await persistor.getAllKeys();
      const results = await Promise.all(
        keys.map(async (key) => {
          try {
            const value = await persistor.getItem(key);
            return { key, value: this.deserialize(value) };
          } catch (unknownError) {
            const err = unknownToError(unknownError);
            if (err.name === "NotFoundError") {
              log("error", "key missing from database", { key });
              return undefined;
            }
            throw err;
          }
        }),
      );
      kvPairs = results.filter(
        (kvPair): kvPair is { key: PersistorKey; value: Serializable } => kvPair !== undefined,
      );
    }

    const result: { [key: string]: Serializable } = {};
    kvPairs.forEach((pair) => {
      insertValueAtLeaf(result, pair.key, pair.value, hive);
    });
    return result;
  }

  private deserialize(input: string): Serializable {
    if (input === undefined || input.length === 0) {
      return "";
    }
    try {
      return JSON.parse(input) as Serializable;
    } catch {
      return undefined;
    }
  }

  private serialize<T>(input: T): string {
    return JSON.stringify(input);
  }
}

export default ReduxPersistorIPC;
