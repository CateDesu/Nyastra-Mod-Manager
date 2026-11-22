import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";

import type { DuckDBConnection, DuckDBResultReader } from "@duckdb/node-api";
import { unknownToError } from "@vortex/shared";
import { DataInvalid, VortexError } from "@vortex/shared/errors";
import { isClobberedKeySegment, type IPersistor } from "@vortex/shared/state";

import { getVortexPath } from "../getVortexPath";
import { log } from "../logging";
import DuckDBSingleton from "./DuckDBSingleton";
import {
  isEncodedStatePath,
  readStateRows,
  stateStorageRoot,
  writeStateRows,
  type StateRow,
} from "./stateRows";
import { insertStateValue } from "./stateTree";

const SEPARATOR: string = "###";

// Threshold (in milliseconds) above which a successful write is logged as
// a warning. Picked to be silent under healthy operation while still
// surfacing meaningful stalls in field log captures.
const SLOW_WRITE_THRESHOLD_MS = 250;

// When VORTEX_TRACE_DB_WRITES=1 is set in the environment, every persistence
// write logs an enter/exit pair at debug level so the "last enter without an
// exit" marks the wedged call. Read per-call so tests (and live operators)
// can flip it via vi.stubEnv / a relaunch without rebuilding.
function traceWritesEnabled(): boolean {
  return process.env.VORTEX_TRACE_DB_WRITES === "1";
}

// Database kinds are main-process-specific, declared next to their throw sites.
declare module "@vortex/shared/errors" {
  interface VortexErrorKindMap {
    /** Another process holds the database lock (usually a second Vortex instance). */
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- kinds without payload use {} like the core catalog
    "database:locked": {};
    /** Opening the database failed for a reason other than lock contention. */
    "database:open-failed": { path: string };
  }
}

// Lock-contention text produced by leveldb's env layer when another process
// holds the LOCK file — matched across platforms.  Only these messages should
// trigger the "another instance is running" code path.
function isLockContention(message: string): boolean {
  return /being used by another process|already held|resource (temporarily )?unavailable|resource busy/i.test(
    message,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LevelPersist implements IPersistor {
  public static async create(
    persistPath: string,
    tries: number = 10,
    repair: boolean = false,
  ): Promise<LevelPersist> {
    if (repair) {
      // Repair is a LevelDB concept — not applicable to DuckDB/level_pivot
      log("warn", "duckdb: repair requested but not supported, ignoring", {
        path: persistPath,
      });
    }
    try {
      const singleton = DuckDBSingleton.getInstance();
      const extensionDir = path.join(getVortexPath("base_unpacked"), "duckdb-extensions");
      await singleton.initialize(extensionDir);

      const alias = singleton.nextAlias();
      const connection = await singleton.attachDatabase(persistPath, alias);
      return new LevelPersist(connection, alias);
    } catch (unknownErr) {
      const err = unknownToError(unknownErr);
      if (err instanceof DataInvalid) {
        throw err;
      }
      if (/corrupt/i.test(err.message)) {
        throw new DataInvalid(err.message);
      }
      if (!isLockContention(err.message)) {
        // Not a lock conflict — retrying won't help. Surface the real cause so
        // the startup handler can show the user an accurate diagnostic instead
        // of the misleading "another instance is running" dialog.
        log("warn", "duckdb: openDB failed", {
          message: err.message,
          path: persistPath,
        });
        throw new VortexError(
          `Failed to open database at ${persistPath}: ${err.message}`,
          { kind: "database:open-failed", path: persistPath },
          { cause: err },
        );
      }
      log("warn", "duckdb: openDB locked, retrying", {
        message: err.message,
        triesRemaining: tries,
        path: persistPath,
      });
      if (tries === 0) {
        throw new VortexError(
          "Database is locked",
          { kind: "database:locked" },
          { isTransient: true, cause: err },
        );
      }
      await delay(500);
      return LevelPersist.create(persistPath, tries - 1, repair);
    }
  }

  #mConnection: DuckDBConnection;
  #mAlias: string;
  #mInTransaction: boolean = false;
  #mOperations: Promise<unknown> = Promise.resolve();
  #mOperationContext = new AsyncLocalStorage<{ active: boolean }>();

  constructor(connection: DuckDBConnection, alias: string) {
    this.#mConnection = connection;
    this.#mAlias = alias;
  }

  public get alias(): string {
    return this.#mAlias;
  }

  public get connection(): DuckDBConnection {
    return this.#mConnection;
  }

  public get inTransaction(): boolean {
    return this.#mInTransaction;
  }

  // Times a write through the connection. Default behaviour: silent on
  // success, warns when the call exceeded SLOW_WRITE_THRESHOLD_MS. With
  // VORTEX_TRACE_DB_WRITES=1 set in the environment, also emits an enter
  // line before the await and an exit line after - so an indefinite hang
  // (where the exit line never appears in vortex.log) pinpoints the
  // wedged call.
  private async timedWrite<T>(method: string, count: number, op: () => Promise<T>): Promise<T> {
    const trace = traceWritesEnabled();
    const start = Date.now();
    if (trace) {
      log("debug", "level_pivot Write enter", {
        method,
        alias: this.#mAlias,
        count,
      });
    }
    try {
      return await op();
    } finally {
      const elapsedMs = Date.now() - start;
      if (trace) {
        log("debug", "level_pivot Write exit", {
          method,
          alias: this.#mAlias,
          count,
          elapsedMs,
        });
      } else if (elapsedMs > SLOW_WRITE_THRESHOLD_MS) {
        log("warn", "level_pivot slow Write", {
          method,
          alias: this.#mAlias,
          count,
          elapsedMs,
        });
      }
    }
  }

  public async close(): Promise<void> {
    await this.#mOperations;
    await DuckDBSingleton.getInstance().detachDatabase(this.#mAlias);
  }

  public setResetCallback(_cb: () => PromiseLike<void>): void {
    // Not implemented for DuckDB backend — DuckDB handles durability internally
  }

  public async getItem(key: string[]): Promise<string> {
    const reader = await this.#mConnection.runAndReadAll(
      `SELECT value FROM ${this.#mAlias}.kv WHERE key = $1`,
      [key.join(SEPARATOR)],
    );
    const rows = reader.getRows();
    const firstRow = rows[0];
    if (firstRow === undefined) {
      const err = new Error(`Key not found: ${key.join(SEPARATOR)}`);
      err.name = "NotFoundError";
      throw err;
    }
    return firstRow[0] as string;
  }

  public async getAllKeys(): Promise<string[][]> {
    const reader = await this.#mConnection.runAndReadAll(`SELECT key FROM ${this.#mAlias}.kv`);
    const rows = reader.getRows();
    return rows.map((row) => (row[0] as string).split(SEPARATOR));
  }

  /**
   * Get all unique hive names that have persisted data.
   * Extracts the first path segment (hive) from each key entirely in SQL.
   */
  public async getPersistedHives(): Promise<string[]> {
    const reader = await this.#mConnection.runAndReadAll(
      `SELECT DISTINCT
         CASE WHEN INSTR(key, '${SEPARATOR}') > 0
           THEN SUBSTR(key, 1, INSTR(key, '${SEPARATOR}') - 1)
           ELSE key
         END AS hive
       FROM ${this.#mAlias}.kv`,
    );
    const rows = reader.getRows();
    return rows.map((row) => row[0] as string);
  }

  public async getAllKVs(prefix?: string): Promise<Array<{ key: string[]; value: string }>> {
    let reader: DuckDBResultReader;
    if (prefix === undefined) {
      reader = await this.#mConnection.runAndReadAll(`SELECT key, value FROM ${this.#mAlias}.kv`);
    } else {
      reader = await this.#mConnection.runAndReadAll(
        `SELECT key, value FROM ${this.#mAlias}.kv WHERE starts_with(key, $1)`,
        [`${prefix}${SEPARATOR}`],
      );
    }
    const rows = reader.getRows();
    return rows.map((row) => ({
      key: (row[0] as string).split(SEPARATOR),
      value: row[1] as string,
    }));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#mOperationContext.getStore()?.active) return operation();
    const next = this.#mOperations.then(async () => {
      const context = { active: true };
      try {
        return await this.#mOperationContext.run(context, operation);
      } finally {
        // Callbacks created here can outlive their transaction.
        context.active = false;
      }
    });
    this.#mOperations = next.catch(() => undefined);
    return next;
  }

  /** Keep a complete read together with participating writes. */
  public withSerializedRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialize(operation);
  }

  /** Serialize read/modify/write operations, including callers outside the renderer. */
  public withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      // Startup import and healing already own an explicit transaction.
      if (this.#mInTransaction) return operation();
      await this.beginTransaction();
      try {
        const result = await operation();
        await this.commitTransaction();
        return result;
      } catch (error) {
        try {
          await this.rollbackTransaction();
        } catch (rollbackError) {
          log("warn", "Failed to rollback transaction", {
            error: unknownToError(rollbackError).message,
          });
        }
        throw error;
      }
    });
  }

  public async setItem(statePath: string[], newState: string | null): Promise<void> {
    await this.timedWrite("setItem", 1, () =>
      this.withTransaction(() => this.changeItems([{ key: statePath, value: newState }])),
    );
  }

  public async removeItem(statePath: string[]): Promise<void> {
    await this.timedWrite("removeItem", 1, () =>
      this.withTransaction(() => this.changeItems([{ key: statePath }])),
    );
  }

  public async bulkSetItem(items: ReadonlyArray<{ key: string[]; value: string }>): Promise<void> {
    if (items.length === 0) return;
    await this.timedWrite("bulkSetItem", items.length, () =>
      this.withTransaction(() => this.changeItems(items)),
    );
  }

  public async bulkRemoveItem(keys: ReadonlyArray<string[]>): Promise<void> {
    if (keys.length === 0) return;
    await this.timedWrite("bulkRemoveItem", keys.length, () =>
      this.withTransaction(() => this.changeItems(keys.map((key) => ({ key })))),
    );
  }

  private async ancestorRows(keys: ReadonlyArray<string[]>): Promise<StateRow[]> {
    const candidates = new Set<string>();
    for (const key of keys) {
      for (let depth = 2; depth < key.length; depth++) {
        const prefix = key.slice(0, depth);
        if (!isEncodedStatePath(prefix)) break;
        candidates.add(prefix.join(SEPARATOR));
      }
    }
    if (candidates.size === 0) return [];
    const params = [...candidates];
    const reader = await this.#mConnection.runAndReadAll(
      `SELECT key, value FROM ${this.#mAlias}.kv WHERE key IN (${params.map((_, i) => `$${i + 1}`).join(", ")})`,
      params,
    );
    return reader
      .getRows()
      .map((row) => ({ key: (row[0] as string).split(SEPARATOR), value: row[1] as string }));
  }

  private async subtreeRows(root: string[]): Promise<StateRow[]> {
    const key = root.join(SEPARATOR);
    const reader = await this.#mConnection.runAndReadAll(
      `SELECT key, value FROM ${this.#mAlias}.kv WHERE key = $1 OR starts_with(key, $2)`,
      [key, `${key}${SEPARATOR}`],
    );
    return reader
      .getRows()
      .map((row) => ({ key: (row[0] as string).split(SEPARATOR), value: row[1] as string }))
      .filter((row) => root.every((segment, i) => row.key[i] === segment));
  }

  /** Read the same ancestor and child precedence used by hydration. */
  public async readStateValue(key: string[]): Promise<unknown> {
    return this.serialize(async () => {
      const ancestors = await this.ancestorRows([key]);
      const root =
        ancestors.sort((a, b) => a.key.length - b.key.length)[0]?.key ?? stateStorageRoot(key);
      let value = readStateRows(await this.subtreeRows(root), root).value;
      for (const segment of key.slice(root.length)) {
        if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment))
          return undefined;
        value = (value as Record<string, unknown>)[segment];
      }
      return value;
    });
  }

  private async changeItems(
    items: ReadonlyArray<{ key: string[]; value?: string | null }>,
  ): Promise<void> {
    const ancestors = await this.ancestorRows(items.map((item) => item.key));
    const overlaps = items.some((item, i) =>
      items.some(
        (other, j) =>
          i !== j &&
          other.key.length < item.key.length &&
          other.key.every((segment, k) => segment === item.key[k]),
      ),
    );
    if (
      ancestors.length === 0 &&
      !overlaps &&
      items.every((item) => isEncodedStatePath(item.key))
    ) {
      // The ordinary leaf layout keeps bounded bulk SQL. Sets replace old descendants too.
      const sets = items[0]?.value !== undefined;
      await this.deleteRows(
        items.filter((item) => !sets || item.key.length > 1).map((item) => item.key),
        sets,
      );
      await this.insertRows(
        items.filter(
          (item): item is { key: string[]; value: string | null } => item.value !== undefined,
        ),
      );
      return;
    }
    for (const item of items) {
      const currentAncestors = await this.ancestorRows([item.key]);
      const encoded = isEncodedStatePath(item.key);
      const root =
        currentAncestors.sort((a, b) => a.key.length - b.key.length)[0]?.key ??
        stateStorageRoot(item.key);
      if (currentAncestors.length === 0 && encoded) {
        await this.deleteRows([item.key], item.value !== undefined);
        if (item.value !== undefined) await this.insertRows([{ key: item.key, value: item.value }]);
        continue;
      }
      const rows = await this.subtreeRows(root);
      if (
        root.length < 2 ||
        rows.some((row) =>
          row.key.some(
            (segment) =>
              isClobberedKeySegment(segment) || Buffer.from(segment).toString("utf8") !== segment,
          ),
        )
      )
        throw new DataInvalid("Cannot rewrite state containing unreadable keys");
      const tree = readStateRows(rows, root);
      const relative = ["value", ...item.key.slice(root.length)];
      if (item.value === undefined) {
        let parent: unknown = tree;
        for (const segment of relative.slice(0, -1)) {
          parent =
            parent !== null && typeof parent === "object" && Object.hasOwn(parent, segment)
              ? (parent as Record<string, unknown>)[segment]
              : undefined;
        }
        if (parent !== null && typeof parent === "object")
          Reflect.deleteProperty(parent, relative.at(-1)!);
      } else {
        let value: unknown;
        try {
          value =
            item.value === null ? null : item.value.length === 0 ? "" : JSON.parse(item.value);
        } catch {
          value = undefined;
        }
        insertStateValue(tree, relative, value);
      }
      const invalid = rows.filter((row) => {
        if (item.key.every((segment, i) => row.key[i] === segment)) return false;
        try {
          if (row.value.length > 0) JSON.parse(row.value);
          return false;
        } catch {
          return true;
        }
      });
      if (item.value !== undefined && item.value !== null) {
        try {
          if (item.value.length > 0) JSON.parse(item.value);
        } catch {
          invalid.push({ key: item.key, value: item.value });
        }
      }
      const replacements = writeStateRows(tree.value, root, invalid);
      await this.replaceRawRows(root, replacements);
    }
  }

  /** Replace reconstructed raw rows without interpreting their JSON again. */
  public async replaceRawRows(root: string[], rows: ReadonlyArray<StateRow>): Promise<void> {
    await this.withTransaction(async () => {
      await this.deleteRows([root]);
      for (let start = 0; start < rows.length; start += 256)
        await this.insertRows(rows.slice(start, start + 256));
    });
  }

  private async insertRows(
    items: ReadonlyArray<{ key: string[]; value: string | null }>,
  ): Promise<void> {
    if (items.length === 0) return;
    const params: Array<string | null> = [];
    const placeholders = items.map((item, i) => {
      params.push(item.key.join(SEPARATOR), item.value);
      return `($${2 * i + 1}, $${2 * i + 2})`;
    });
    await this.#mConnection.run(
      `INSERT INTO ${this.#mAlias}.kv VALUES ${placeholders.join(", ")}`,
      params,
    );
  }

  private async deleteRows(input: ReadonlyArray<string[]>, descendantsOnly = false): Promise<void> {
    const keys = descendantsOnly ? input.filter((key) => !key.at(-1)?.endsWith("#")) : input;
    if (keys.length === 0) return;
    const params: string[] = [];
    const clauses = keys.map((key) => {
      const exact = params.push(key.join(SEPARATOR));
      if (key.at(-1)?.endsWith("#")) return `key = $${exact}`;
      const prefix = params.push(`${key.join(SEPARATOR)}${SEPARATOR}`);
      return descendantsOnly
        ? `(key != $${exact} AND starts_with(key, $${prefix}))`
        : `key = $${exact} OR starts_with(key, $${prefix})`;
    });
    await this.#mConnection.run(
      `DELETE FROM ${this.#mAlias}.kv WHERE ${clauses.join(" OR ")}`,
      params,
    );
  }

  /**
   * Begin a transaction on this connection. The in-transaction flag is only
   * set if BEGIN succeeds.
   */
  public async beginTransaction(): Promise<void> {
    await this.#mConnection.run("BEGIN TRANSACTION");
    this.#mInTransaction = true;
  }

  /**
   * Commit the current transaction.
   */
  public async commitTransaction(): Promise<void> {
    try {
      await this.#mConnection.run("COMMIT");
    } finally {
      this.#mInTransaction = false;
    }
  }

  /**
   * Rollback the current transaction.
   */
  public async rollbackTransaction(): Promise<void> {
    try {
      await this.#mConnection.run("ROLLBACK");
    } finally {
      this.#mInTransaction = false;
    }
  }

  /**
   * Get dirty tables from level_pivot (tables modified in the current transaction).
   * Returns array of {database, table, type} tuples.
   */
  public async getDirtyTables(): Promise<Array<{ database: string; table: string; type: string }>> {
    const reader = await this.#mConnection.runAndReadAll(
      "SELECT * FROM level_pivot_dirty_tables()",
    );
    const rows = reader.getRows();
    return rows.map((row) => ({
      database: row[0] as string,
      table: row[1] as string,
      type: row[2] as string,
    }));
  }
}

export default LevelPersist;
