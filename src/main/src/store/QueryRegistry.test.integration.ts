import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, expect, it, vi } from "vitest";

import { Database } from "./Database";
import DuckDBSingleton from "./DuckDBSingleton";
import LevelPersist from "./LevelPersist";
import { normalizeStateBlobs } from "./normalizeStateBlobs";
import QueryInvalidator from "./QueryInvalidator";
import { parseAllQueries, type ParsedQuery } from "./queryParser";
import QueryRegistry from "./QueryRegistry";
import QueryWatcher from "./QueryWatcher";

vi.mock("../logging", () => ({ log: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  DuckDBSingleton.getInstance().close();
});

function select(
  name: string,
  sql: string,
  params: ParsedQuery["params"] = [],
  dependencies?: string[],
): ParsedQuery {
  return {
    name,
    sql,
    params,
    dependencies,
    type: "select",
    description: "",
    filePath: "synthetic.sql",
  };
}

it("native dependencies retain aliases, quoted identifiers, CTEs and catalog boundaries", async () => {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const registry = new QueryRegistry(connection);
    await registry.initialize([
      select("explicit", "SELECT * FROM db.mods AS m"),
      select("implicit", "SELECT * FROM db.mods m"),
      select("plain", "SELECT * FROM db.mods"),
      select("cte", "WITH x AS (SELECT * FROM db.mods AS m) SELECT * FROM x"),
      select("columns", "SELECT * FROM db.mods AS m(a, b)"),
      select("quoted", 'SELECT * FROM "db"."table AS name" AS "alias AS name"'),
      select("escaped", 'SELECT * FROM "db"."table""name" AS m'),
      select("dots", 'SELECT * FROM "db"."table.with.dots" AS m'),
      select("otherCatalog", "SELECT * FROM other.mods AS m"),
      select("unqualified", "SELECT * FROM mods AS m"),
      select("unrelated", "SELECT * FROM db.profiles AS p"),
    ]);
    expect(registry.getAffectedQueries(["db.mods", "mods"]).sort()).toEqual([
      "columns",
      "cte",
      "explicit",
      "implicit",
      "plain",
      "unqualified",
    ]);
    expect(registry.getAffectedQueries(["db.table AS name", "table AS name"])).toEqual(["quoted"]);
    expect(registry.getAffectedQueries(['db.table"name', 'table"name'])).toEqual(["escaped"]);
    expect(registry.getAffectedQueries(["db.table.with.dots", "table.with.dots"])).toEqual([
      "dots",
    ]);
    expect(registry.getAffectedQueries(["db.profiles", "profiles"])).toEqual(["unrelated"]);
    expect(registry.getAffectedQueries(["unrelated"])).toEqual([]);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});

it("native commit invalidates the real watcher without refreshing unrelated subscriptions", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "query-watcher-"));
  const singleton = DuckDBSingleton.getInstance();
  let unsubscribe: (() => void) | undefined;
  let unsubscribeOther: (() => void) | undefined;
  try {
    await singleton.initialize(path.resolve(import.meta.dirname, "../../build/duckdb-extensions"));
    const alias = singleton.nextAlias();
    const persist = new LevelPersist(await singleton.attachDatabase(root, alias), alias);
    const attributes = ["persistent", "mods", "skyrimse", "retained", "attributes"];
    await persist.setItem(
      attributes.slice(0, 3),
      JSON.stringify({
        retained: {
          id: "retained",
          state: "installed",
          attributes: {
            source: "nexus",
            modId: 10,
            fileId: 20,
            "literal###name": "keep",
          },
        },
      }),
    );
    await persist.setItem(["persistent", "profiles", "p", "gameId"], '"skyrimse"');
    await persist.setItem(["settings", "profiles", "activeProfileId"], '"p"');
    await normalizeStateBlobs(persist);
    const registry = new QueryRegistry(await singleton.createConnection());
    await registry.initialize([
      ...parseAllQueries(path.resolve(import.meta.dirname, "../../../queries"), alias),
      select(
        "other_profiles",
        `SELECT gameId AS game_id FROM ${alias}.profiles_pivot WHERE gameId != 'skyrimse' ORDER BY game_id`,
      ),
    ]);
    const watcher = new QueryWatcher(registry);
    const invalidator = new QueryInvalidator(registry, 1);
    invalidator.setWatcher(watcher);
    const db = new Database(persist, invalidator);
    const execute = vi.spyOn(registry, "executeQuery");
    const diffs = vi.fn();
    const otherDiffs = vi.fn();
    unsubscribe = watcher.watch("active_profile_nexus_files", {}, diffs);
    unsubscribeOther = watcher.watch("other_profiles", {}, otherDiffs);
    await Promise.all(execute.mock.results.map((result) => result.value as Promise<unknown>));
    expect(
      await registry.executeQuery("recently_managed_games", { current_game_id: "skyrimse" }),
    ).toEqual([]);
    execute.mockClear();
    const notify = vi.spyOn(invalidator, "notifyDirtyTables");
    const refreshed = Promise.withResolvers<void>();
    const refresh = watcher.onQueriesInvalidated.bind(watcher);
    vi.spyOn(watcher, "onQueriesInvalidated").mockImplementation(async (names) => {
      await refresh(names);
      refreshed.resolve();
    });
    await expect(
      db.transaction(async () => {
        await persist.setItem([...attributes, "fileId"], "99");
        throw new Error("cancel writer");
      }),
    ).rejects.toThrow("cancel writer");
    await delay(20);
    expect(notify).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(diffs).not.toHaveBeenCalled();

    await db.transaction(async () => {
      await persist.setItem([...attributes, "fileId"], "24");
    });
    expect((await registry.executeQuery("active_profile_nexus_files"))[0]?.file_id).toBe("24");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: "mod_attributes_pivot" })]),
    );
    await refreshed.promise;
    const automatic = diffs.mock.calls.length;
    // Explicit invalidation controls for native execution and diff comparison.
    await watcher.onQueriesInvalidated(["active_profile_nexus_files"]);
    expect(diffs).toHaveBeenCalledTimes(1);
    expect(diffs.mock.calls[0]![0]).toMatchObject({
      previous: [{ file_id: "20" }],
      current: [{ file_id: "24" }],
    });
    expect(execute.mock.calls.every(([name]) => name === "active_profile_nexus_files")).toBe(true);
    expect(otherDiffs).not.toHaveBeenCalled();
    expect(automatic).toBe(1);

    await db.transaction(async () => {
      await persist.bulkSetItem([
        { key: ["persistent", "profiles", "other", "gameId"], value: '"fallout4"' },
        { key: ["persistent", "profiles", "other", "lastActivated"], value: "42" },
      ]);
    });
    await vi.waitFor(() => expect(otherDiffs).toHaveBeenCalledTimes(1));
    expect(otherDiffs.mock.calls[0]![0]).toMatchObject({ current: [{ game_id: "fallout4" }] });
    expect(diffs).toHaveBeenCalledTimes(1);
    unsubscribe();
    execute.mockClear();
    await db.transaction(async () => {
      await persist.setItem([...attributes, "fileId"], "26");
    });
    await delay(20);
    expect(execute).not.toHaveBeenCalled();
    expect(diffs).toHaveBeenCalledTimes(1);
    expect(otherDiffs).toHaveBeenCalledTimes(1);
    await persist.close();
  } finally {
    unsubscribe?.();
    unsubscribeOther?.();
    singleton.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["db", "db_7"])(
  "refreshes recently_managed_games after a native profile commit in %s",
  async (alias) => {
    const root = mkdtempSync(path.join(tmpdir(), "query-dependency-gap-"));
    const singleton = DuckDBSingleton.getInstance();
    const unsubscribes: (() => void)[] = [];
    try {
      await singleton.initialize(
        path.resolve(import.meta.dirname, "../../build/duckdb-extensions"),
      );
      const persist = new LevelPersist(await singleton.attachDatabase(root, alias), alias);
      const connection = await singleton.createConnection();
      const queries = parseAllQueries(path.resolve(import.meta.dirname, "../../../queries"), alias);
      const production = queries.find((query) => query.name === "recently_managed_games")!;
      const registry = new QueryRegistry(connection);
      await registry.initialize([
        ...queries,
        select(
          "profile_control",
          `SELECT gameId AS game_id FROM ${alias}.profiles_pivot ORDER BY game_id`,
        ),
        select(
          "mod_control",
          `SELECT fileId AS file_id FROM ${alias}.mod_attributes_pivot ORDER BY file_id`,
        ),
      ]);
      const watcher = new QueryWatcher(registry);
      const invalidator = new QueryInvalidator(registry, 1);
      invalidator.setWatcher(watcher);
      const database = new Database(persist, invalidator);
      const diffs = vi.fn();
      const profileDiffs = vi.fn();
      const modDiffs = vi.fn();
      const execute = vi.spyOn(registry, "executeQuery");
      unsubscribes.push(watcher.watch(production.name, { current_game_id: "skyrimse" }, diffs));
      unsubscribes.push(watcher.watch("profile_control", {}, profileDiffs));
      unsubscribes.push(watcher.watch("mod_control", {}, modDiffs));
      await Promise.all(execute.mock.results.map((result) => result.value as Promise<unknown>));
      execute.mockClear();
      const dirty = vi.spyOn(invalidator, "notifyDirtyTables");
      const refreshed = vi.spyOn(watcher, "onQueriesInvalidated");
      await expect(
        database.transaction(async () => {
          await persist.bulkSetItem([
            { key: ["persistent", "profiles", "rolled_back", "gameId"], value: '"rollback"' },
            { key: ["persistent", "profiles", "rolled_back", "lastActivated"], value: "99" },
          ]);
          throw new Error("cancel profile write");
        }),
      ).rejects.toThrow("cancel profile write");
      await delay(20);
      expect(dirty).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(diffs).not.toHaveBeenCalled();
      expect(profileDiffs).not.toHaveBeenCalled();

      await database.transaction(async () => {
        await persist.bulkSetItem([
          { key: ["persistent", "profiles", "other", "gameId"], value: '"fallout4"' },
          { key: ["persistent", "profiles", "other", "lastActivated"], value: "42" },
        ]);
      });
      await vi.waitFor(() => expect(profileDiffs).toHaveBeenCalledTimes(1));
      await Promise.all(refreshed.mock.results.map((result) => result.value as Promise<void>));
      expect(dirty.mock.calls.flat(2)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ database: alias, table: "profiles_pivot" }),
        ]),
      );
      expect(modDiffs).not.toHaveBeenCalled();
      expect(execute.mock.calls.some(([name]) => name === "mod_control")).toBe(false);
      const automatic = diffs.mock.calls.length;
      const affected = registry.getAffectedQueries([`${alias}.profiles_pivot`, "profiles_pivot"]);
      const direct = await registry.executeQuery(production.name, { current_game_id: "skyrimse" });
      expect(direct).toEqual([{ game_id: "fallout4" }]);
      expect(await registry.executeQuery(production.name, { current_game_id: "fallout4" })).toEqual(
        [],
      );
      await watcher.onQueriesInvalidated([production.name]);
      expect(diffs).toHaveBeenCalledTimes(1);
      expect(diffs.mock.calls[0]![0]).toEqual({
        queryName: production.name,
        previous: [],
        current: [{ game_id: "fallout4" }],
      });
      await watcher.onQueriesInvalidated([production.name]);
      expect(diffs).toHaveBeenCalledTimes(1);

      execute.mockClear();
      await database.transaction(async () => {
        await persist.setItem(
          ["persistent", "mods", "skyrimse", "synthetic", "attributes", "fileId"],
          "24",
        );
      });
      await vi.waitFor(() => expect(modDiffs).toHaveBeenCalledTimes(1));
      await Promise.all(refreshed.mock.results.map((result) => result.value as Promise<void>));
      expect(execute.mock.calls.map(([name]) => name)).toEqual(["mod_control"]);
      expect(profileDiffs).toHaveBeenCalledTimes(1);
      expect(diffs).toHaveBeenCalledTimes(1);
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      execute.mockClear();
      await database.transaction(async () => {
        await persist.setItem(["persistent", "profiles", "other", "gameId"], '"oblivion"');
      });
      await delay(20);
      await Promise.all(refreshed.mock.results.map((result) => result.value as Promise<void>));
      expect(execute).not.toHaveBeenCalled();
      await persist.close();
      expect(automatic).toBe(1);
      expect(affected).toContain(production.name);
    } finally {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      singleton.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("declared dependencies cover parameter positions while preserving native discovery and query isolation", async () => {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run("ATTACH ':memory:' AS db; ATTACH ':memory:' AS other");
    await connection.run(
      'CREATE TABLE db."table AS name" (id INTEGER, name VARCHAR); CREATE TABLE other."table AS name" (id INTEGER, name VARCHAR)',
    );
    await connection.run("INSERT INTO db.\"table AS name\" VALUES (2, 'retained')");
    const definitions: [
      string,
      string,
      Record<string, string | number>,
      Record<string, unknown>[],
    ][] = [
      [
        "named_predicate",
        'SELECT id FROM db."table AS name" AS m WHERE id = $id',
        { id: 2 },
        [{ id: 2 }],
      ],
      [
        "named_projection",
        'SELECT $value AS value FROM db."table AS name" m',
        { value: "bound" },
        [{ value: "bound" }],
      ],
      [
        "repeated",
        'SELECT $id AS value FROM db."table AS name" AS m WHERE id = $id',
        { id: 2 },
        [{ value: 2 }],
      ],
      [
        "positional",
        'SELECT id FROM db."table AS name" AS m WHERE id = $1',
        { "1": 2 },
        [{ id: 2 }],
      ],
      ["question", 'SELECT id FROM db."table AS name" AS m WHERE id = ?', { "1": 2 }, [{ id: 2 }]],
      ["limit", 'SELECT id FROM db."table AS name" AS m LIMIT $count', { count: 1 }, [{ id: 2 }]],
      [
        "cte",
        'WITH x AS (SELECT * FROM db."table AS name" AS m WHERE id = $id) SELECT id FROM x',
        { id: 2 },
        [{ id: 2 }],
      ],
      [
        "comment_literals",
        `SELECT '$id' AS literal, $$? $1$$ AS dollar, id FROM db."table AS name" AS "alias $id" WHERE id = $id /* $bad /* ? */ $1 */ -- $ignored\n`,
        { id: 2 },
        [{ literal: "$id", dollar: "? $1", id: 2 }],
      ],
    ];
    const registry = new QueryRegistry(connection);
    await registry.initialize(
      definitions.map(([name, sql, values]) =>
        select(
          name,
          sql,
          Object.entries(values).map(([param, value]) => ({
            name: param,
            duckdbType: typeof value === "number" ? "INTEGER" : "VARCHAR",
          })),
          ['"db"."table AS name"'],
        ),
      ),
    );
    for (const [name, , values, expected] of definitions) {
      const actual = await registry.executeQuery(name, values);
      expect(actual).toEqual(expected);
    }
    expect(registry.getAffectedQueries(["db.table AS name", "table AS name"])).toEqual(
      definitions.map(([name]) => name),
    );
    const literals = select(
      "literal_control",
      `SELECT '$id ? $1' AS value FROM db."table AS name" AS "alias $id" /* $ignored /* ? */ $1 */ -- $ignored\n`,
    );
    const other = select("catalog_control", 'SELECT * FROM other."table AS name" AS m');
    await registry.initialize([literals, other]);
    expect(registry.getAffectedQueries(["db.table AS name", "table AS name"])).toEqual([
      ...definitions.map(([name]) => name),
      "literal_control",
    ]);
    expect(await registry.executeQuery("literal_control")).toEqual([{ value: "$id ? $1" }]);
    expect(await registry.executeQuery("catalog_control")).toEqual([]);
    expect(registry.getAffectedQueries(["other.table AS name"])).toEqual(["catalog_control"]);
    expect(registry.getAffectedQueries(["unrelated"])).toEqual([]);
    const combined = select(
      "combined",
      'SELECT * FROM db."table AS name" AS m',
      [],
      ['other."table AS name" AS "alias AS name"', 'other."table AS name"'],
    );
    await registry.initialize([combined]);
    expect(registry.getAffectedQueries(["db.table AS name"])).toContain("combined");
    expect(registry.getAffectedQueries(["other.table AS name"])).toEqual([
      "catalog_control",
      "combined",
    ]);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});
