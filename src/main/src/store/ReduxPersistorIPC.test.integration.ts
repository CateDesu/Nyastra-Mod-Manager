import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import DuckDBSingleton from "./DuckDBSingleton";
import LevelPersist from "./LevelPersist";
import ReduxPersistorIPC from "./ReduxPersistorIPC";
import SubPersistor from "./SubPersistor";

const directories: string[] = [];
afterEach(() => {
  DuckDBSingleton.getInstance().close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("preserves special mod IDs through real database persistence and reopening", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nyastra-hydration-"));
  directories.push(directory);
  const singleton = DuckDBSingleton.getInstance();
  await singleton.initialize(path.resolve(import.meta.dirname, "../../build/duckdb-extensions"));
  const open = async () => {
    const alias = singleton.nextAlias();
    return new LevelPersist(await singleton.attachDatabase(directory, alias), alias);
  };
  const original = await open();
  for (const id of ["__proto__", "constructor", "prototype", "ordinary", "日本語"])
    await original.setItem(["persistent", "mods", id, "id"], JSON.stringify(id));
  await original.close();
  const reopened = await open();
  const loaded = await new ReduxPersistorIPC().insertPersistor(
    "persistent",
    new SubPersistor(reopened, "persistent"),
  );
  const mods = loaded.mods as Record<string, { id: string }>;
  expect(Object.keys(mods).sort()).toEqual(
    ["__proto__", "constructor", "prototype", "ordinary", "日本語"].sort(),
  );
  for (const [id, mod] of Object.entries(mods)) expect(mod.id).toBe(id);
  expect(Object.hasOwn(Object.prototype, "id")).toBe(false);
  await reopened.close();
});
