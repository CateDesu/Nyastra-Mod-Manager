import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, beforeEach, afterEach, it, expect } from "vitest";

import { parseAllQueries } from "./queryParser";

describe("queryParser", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qparser-"));
    fs.mkdirSync(path.join(tmpDir, "setup"));
    fs.mkdirSync(path.join(tmpDir, "select"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses @alias annotation", () => {
    fs.writeFileSync(
      path.join(tmpDir, "select", "test.sql"),
      `-- @type select\n-- @name my_long_query_name\n-- @alias myQuery\nSELECT 1;\n`,
    );

    const queries = parseAllQueries(tmpDir);

    expect(queries).toHaveLength(1);
    expect(queries[0]!.name).toBe("my_long_query_name");
    expect(queries[0]!.alias).toBe("myQuery");
  });

  it("alias is undefined when not specified", () => {
    fs.writeFileSync(
      path.join(tmpDir, "select", "test.sql"),
      `-- @type select\n-- @name simple_query\nSELECT 1;\n`,
    );

    const queries = parseAllQueries(tmpDir);

    expect(queries[0]!.alias).toBeUndefined();
  });

  it("parses @alias on setup queries", () => {
    fs.writeFileSync(
      path.join(tmpDir, "setup", "test.sql"),
      `-- @type setup\n-- @name my_pivot\n-- @alias myModel\nSELECT 1;\n`,
    );

    const queries = parseAllQueries(tmpDir);

    expect(queries[0]!.alias).toBe("myModel");
  });

  it.each(["db", "db_9", `catalog'"$&`])(
    "binds dependency declarations to catalog %s",
    (catalog) => {
      fs.writeFileSync(
        path.join(tmpDir, "select", "test.sql"),
        [
          "-- @type select",
          "-- @name first",
          "-- @param id INTEGER",
          "-- @depends-on {{persistor_catalog}}.profiles_pivot",
          '-- @depends-on other."table AS name"',
          "SELECT '$id' AS literal FROM {{persistor_catalog}}.profiles_pivot WHERE id = $id;",
          "-- @name second",
          "SELECT 2;",
          "-- @name third",
          "-- @depends-on {{persistor_catalog}}.mods_pivot",
          "SELECT 3;",
        ].join("\n"),
      );
      const identifier = `"${catalog.replaceAll('"', '""')}"`;
      const [first, second, third] = parseAllQueries(tmpDir, catalog);
      expect(first!.dependencies).toEqual([
        `${identifier}.profiles_pivot`,
        'other."table AS name"',
      ]);
      expect(first!.sql).toBe(
        `SELECT '$id' AS literal FROM ${identifier}.profiles_pivot WHERE id = $id;`,
      );
      expect(first!.params).toEqual([{ name: "id", duckdbType: "INTEGER" }]);
      expect(second!.dependencies).toBeUndefined();
      expect(third!.dependencies).toEqual([`${identifier}.mods_pivot`]);
    },
  );

  it("preserves dependency-like lines inside the SQL body", () => {
    const sql = [
      "SELECT $$literal",
      "-- @depends-on ignored.literal",
      "$$ AS value",
      "/* comment",
      "-- @depends-on ignored.comment",
      "*/ FROM db.mods;",
      "-- @depends-on ignored.trailing",
    ].join("\n");
    fs.writeFileSync(
      path.join(tmpDir, "select", "test.sql"),
      `-- @type select\n-- @name body\n-- @depends-on db.mods\n${sql}\n`,
    );
    const [query] = parseAllQueries(tmpDir);
    expect(query!.sql).toBe(sql);
    expect(query!.dependencies).toEqual(["db.mods"]);
  });
});
