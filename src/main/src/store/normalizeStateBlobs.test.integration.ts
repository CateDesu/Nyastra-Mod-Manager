import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DiffOperation } from "@vortex/shared/ipc";
import { applyMiddleware, createStore, type Middleware, type Reducer } from "redux";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import DuckDBSingleton from "./DuckDBSingleton";
import { flattenState } from "./flattenState";
import { healInvalidKeys } from "./healInvalidKeys";
import LevelPersist from "./LevelPersist";
import { normalizeStateBlobs } from "./normalizeStateBlobs";
import type QueryInvalidator from "./QueryInvalidator";
import ReduxPersistorIPC from "./ReduxPersistorIPC";
import SubPersistor from "./SubPersistor";

vi.mock("../logging", () => ({ log: vi.fn() }));
vi.mock("../errorHandling", () => ({
  terminate: (error: Error) => {
    throw error;
  },
}));
vi.mock("../../../renderer/src/logging", () => ({ log: vi.fn() }));
vi.mock("../../../renderer/src/extensions/mod_management/util/testModReference", () => ({
  referenceEqual: () => false,
}));

interface RawDatabase {
  open(options: { createIfMissing: boolean }, callback: (error?: Error) => void): void;
  put(key: Buffer, value: Buffer, callback: (error?: Error) => void): void;
  close(callback: (error?: Error) => void): void;
}
const leveldown = createRequire(import.meta.url)("leveldown") as (directory: string) => RawDatabase;
const roots: string[] = [];
const prefix = ["persistent", "mods", "skyrimse"];
const key = (...segments: string[]) => Buffer.from(segments.join("###"));
const ext = path.resolve(import.meta.dirname, "../../build/duckdb-extensions");
const mod = {
  id: "retained",
  installationPath: "retained",
  state: "installed",
  type: "",
  attributes: { name: "Original", obsolete: true },
};
let middleware: (
  getApi: () => { sendDiff: (hive: string, operations: DiffOperation[]) => void },
) => Middleware;
let flush: () => void;
let reduceMod: Record<string, (state: unknown, payload: unknown) => unknown>;
type RendererPersistence = {
  createPersistDiffMiddleware: typeof middleware;
  flushPendingDiffsSync: typeof flush;
};
type ModReducers = { modsReducer: { reducers: typeof reduceMod } };

beforeAll(async () => {
  const renderer = path.resolve(import.meta.dirname, "../../../renderer/src");
  const persistence = (await import(
    path.join(renderer, "store/persistDiffMiddleware.ts")
  )) as RendererPersistence;
  middleware = persistence.createPersistDiffMiddleware;
  flush = persistence.flushPendingDiffsSync;
  reduceMod = (
    (await import(path.join(renderer, "extensions/mod_management/reducers/mods.ts"))) as ModReducers
  ).modsReducer.reducers;
});
afterEach(() => {
  vi.restoreAllMocks();
  DuckDBSingleton.getInstance().close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function seed(rows: Array<[Buffer, string]>) {
  const root = mkdtempSync(path.join(tmpdir(), "nyastra-object-rows-"));
  roots.push(root);
  const raw = leveldown(root);
  await new Promise<void>((resolve, reject) =>
    raw.open({ createIfMissing: true }, (error) => (error ? reject(error) : resolve())),
  );
  try {
    for (const [name, value] of rows)
      await new Promise<void>((resolve, reject) =>
        raw.put(name, Buffer.from(value), (error) => (error ? reject(error) : resolve())),
      );
  } finally {
    await new Promise<void>((resolve, reject) =>
      raw.close((error) => (error ? reject(error) : resolve())),
    );
  }
  return root;
}
async function open(root: string) {
  const singleton = DuckDBSingleton.getInstance();
  await singleton.initialize(ext);
  const alias = singleton.nextAlias();
  return new LevelPersist(await singleton.attachDatabase(root, alias), alias);
}
const hydrate = (persist: LevelPersist) =>
  new ReduxPersistorIPC().insertPersistor("persistent", new SubPersistor(persist, "persistent"));

for (const layout of ["blob-healed", "blob-clean", "leaf-healed", "blob-direct"]) {
  for (const action of ["REMOVE_MOD", "SET_MOD_ATTRIBUTE", "REMOVE_ATTRIBUTE"]) {
    it(`${layout}: ${action} survives actual reducer, middleware, transaction, flush and reopen`, async () => {
      const rows: Array<[Buffer, string]> = [
        [key(...prefix, "healthy", "id"), '"healthy"'],
        [key("settings", "window", "width"), " 800 "],
      ];
      if (layout === "leaf-healed") {
        for (const leaf of flattenState(mod, [...prefix, "retained"]))
          rows.push([key(...leaf.key), JSON.stringify(leaf.value)]);
      } else rows.push([key(...prefix), JSON.stringify({ retained: mod })]);
      if (layout !== "blob-clean")
        rows.push([
          Buffer.concat([
            key(...prefix),
            Buffer.from("###bad"),
            Buffer.from([255]),
            Buffer.from("###id"),
          ]),
          '"bad"',
        ]);
      const root = await seed(rows);
      let persist = await open(root);
      const healed = await healInvalidKeys(persist);
      expect(healed.removed).toBe(layout === "blob-clean" ? 0 : 1);
      const before = await hydrate(persist);
      if (layout !== "blob-direct") await normalizeStateBlobs(persist);
      expect(await hydrate(persist)).toEqual(before);
      const notifications = vi.fn();
      const ipc = new ReduxPersistorIPC();
      ipc.setQueryInvalidator(persist, {
        notifyDirtyTables: notifications,
      } as unknown as QueryInvalidator);
      const data = await ipc.insertPersistor("persistent", new SubPersistor(persist, "persistent"));
      const reducer: Reducer<{ persistent: Record<string, unknown> }, { type: string }> = (
        state = { persistent: data },
        input,
      ) => {
        const type = input.type === "REMOVE_ATTRIBUTE" ? "SET_MOD_ATTRIBUTE" : input.type;
        const reduce = reduceMod[type];
        if (!reduce) return state;
        return {
          persistent: {
            ...state.persistent,
            mods: reduce(state.persistent.mods, {
              gameId: "skyrimse",
              modId: "retained",
              attribute: input.type === "REMOVE_ATTRIBUTE" ? "obsolete" : "name",
              value: input.type === "REMOVE_ATTRIBUTE" ? undefined : "Updated",
            }),
          },
        };
      };
      const operations: DiffOperation[] = [];
      const store = createStore(
        reducer,
        applyMiddleware(
          middleware(() => ({
            sendDiff: (hive, ops) => {
              operations.push(...ops);
              ipc.applyDiffOperations(hive, ops);
            },
          })),
        ),
      );
      store.dispatch({ type: "INIT" });
      store.dispatch({ type: action });
      flush();
      await ipc.finalizeWrite();
      expect(operations.length).toBeGreaterThan(0);
      expect(await persist.getItem(["settings", "window", "width"])).toBe(" 800 ");
      await persist.close();
      persist = await open(root);
      const reopened = await hydrate(persist);
      expect(reopened).toEqual(store.getState().persistent);
      if (action === "REMOVE_MOD")
        expect(
          (reopened.mods as Record<string, Record<string, unknown>>).skyrimse!.retained,
        ).toBeUndefined();
      await persist.close();
    });
  }
}

it("normalization preserves overrides, arrays, null, empty and special properties and unrelated bytes", async () => {
  const root = await seed([
    [
      key(...prefix),
      ' {"retained":{"attributes":{"name":"parent","tags":["one",null,{}],"empty":{},"nil":null,"blank":"","stable":[null,{},[]],"emptyArray":[]}},"__proto__":{"safe":true},"constructor":{"prototype":{"safe":true}}} ',
    ],
    [
      key(...prefix, "retained", "attributes"),
      '{"name":"child","tags":["override"],"empty":{},"nil":null,"blank":"","stable":[null,{},[]],"emptyArray":[]}',
    ],
    [key(...prefix, "retained", "attributes", "name"), '"grandchild"'],
    [key("persistent", "mods", "skyrimse2", "nearby"), " [1,null,{}] "],
    [key("settings", "window", "width"), " 800 "],
    [key("settings", "unknown"), "invalid JSON"],
    [key("settings", "empty"), ""],
    [key("settings", "emptyObject"), " {} "],
    [key("settings", "null"), " null "],
    [key("persistent"), ' {"ignoredHiveRow":true} '],
  ]);
  let persist = await open(root);
  const before = await hydrate(persist);
  await normalizeStateBlobs(persist);
  expect(await hydrate(persist)).toEqual(before);
  const normalized = await persist.getAllKVs();
  expect(await persist.getItem([...prefix, "retained", "attributes", "name"])).toBe('"grandchild"');
  expect(await persist.getItem([...prefix, "retained", "attributes", "empty"])).toBe("{}");
  expect(await persist.getItem([...prefix, "retained", "attributes", "nil"])).toBe("null");
  expect(await persist.getItem([...prefix, "retained", "attributes", "tags"])).toBe('["override"]');
  expect(await persist.getItem([...prefix, "__proto__", "safe"])).toBe("true");
  expect(Object.hasOwn(Object.prototype, "safe")).toBe(false);
  expect(await persist.getItem(["persistent", "mods", "skyrimse2", "nearby"])).toBe(
    " [1,null,{}] ",
  );
  expect(await persist.getItem(["settings", "window", "width"])).toBe(" 800 ");
  expect(await persist.getItem(["settings", "unknown"])).toBe("invalid JSON");
  expect(await persist.getItem(["settings", "empty"])).toBe("");
  expect(await persist.getItem(["settings", "emptyObject"])).toBe(" {} ");
  expect(await persist.getItem(["settings", "null"])).toBe(" null ");
  expect(await persist.getItem(["persistent"])).toBe(' {"ignoredHiveRow":true} ');
  await normalizeStateBlobs(persist);
  expect(await persist.getAllKVs()).toEqual(normalized);
  await persist.close();
  persist = await open(root);
  expect(await hydrate(persist)).toEqual(before);
  await persist.close();
});

for (const boundary of ["after-delete", "partial-reinsert"]) {
  it(`native normalization rollback preserves original rows at ${boundary}`, async () => {
    const root = await seed([
      [key(...prefix), JSON.stringify({ retained: mod })],
      [key(...prefix, "healthy", "id"), '"healthy"'],
      [key("settings", "window", "width"), "800"],
    ]);
    let persist = await open(root);
    const before = await persist.getAllKVs();
    const run = persist.connection.run.bind(persist.connection);
    vi.spyOn(persist.connection, "run").mockImplementation(async (sql, ...args) => {
      const result = await run(sql, ...args);
      if (
        (boundary === "after-delete" && sql.startsWith("DELETE")) ||
        (boundary === "partial-reinsert" && sql.startsWith("INSERT"))
      )
        throw new Error("fixture normalization failure");
      return result;
    });
    await expect(normalizeStateBlobs(persist)).rejects.toThrow("fixture normalization failure");
    vi.restoreAllMocks();
    expect(await persist.getAllKVs()).toEqual(before);
    await persist.close();
    persist = await open(root);
    expect(await persist.getAllKVs()).toEqual(before);
    await normalizeStateBlobs(persist);
    expect(await hydrate(persist)).toEqual({
      mods: { skyrimse: { retained: mod, healthy: { id: "healthy" } } },
    });
    await persist.close();
  });
}

async function compilePersistence() {
  const { rolldown } = await import("rolldown");
  const compiled = mkdtempSync(path.join(tmpdir(), "nyastra-normalize-process-"));
  roots.push(compiled);
  for (const input of [
    Object.fromEntries(
      ["LevelPersist", "DuckDBSingleton", "stateTree", "stateRows", "normalizeStateBlobs"].map(
        (name) => [name, path.join(import.meta.dirname, `${name}.ts`)],
      ),
    ),
    { sharedState: path.resolve(import.meta.dirname, "../../../shared/src/types/state.ts") },
  ]) {
    const build = await rolldown({
      input,
      external: (id) => !path.isAbsolute(id),
      treeshake: false,
    });
    try {
      await build.write({
        dir: compiled,
        format: "cjs",
        exports: "named",
        entryFileNames: "[name].js",
      });
    } finally {
      await build.close();
    }
  }
  return compiled;
}

for (const boundary of ["after-delete", "partial-reinsert", "after-commit"]) {
  it(`SIGKILL at normalization ${boundary} reopens with complete state`, async () => {
    const root = await seed([
      [key(...prefix), JSON.stringify({ retained: mod })],
      [key(...prefix, "healthy", "id"), '"healthy"'],
      [key("settings", "window", "width"), " 800 "],
    ]);
    const { spawnSync } = await import("node:child_process");
    const compiled = await compilePersistence();
    let persist = await open(root);
    const before = await persist.getAllKVs();
    const hydrated = await hydrate(persist);
    await persist.close();
    const result = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "normalizeStateBlobs.process.fixture.cjs"),
        root,
        ext,
        compiled,
        path.resolve(import.meta.dirname, "../../package.json"),
        boundary,
      ],
      { encoding: "utf8", timeout: 20000, env: { ...process.env, NODE_OPTIONS: "" } },
    );
    expect(result.error).toBeUndefined();
    expect(
      result.signal,
      JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }),
    ).toBe("SIGKILL");
    expect(result.stdout).toBe(boundary);
    expect(result.stderr).toBe("");
    persist = await open(root);
    if (boundary !== "after-commit") expect(await persist.getAllKVs()).toEqual(before);
    else await expect(persist.getItem(prefix)).rejects.toMatchObject({ name: "NotFoundError" });
    expect(await hydrate(persist)).toEqual(hydrated);
    await normalizeStateBlobs(persist);
    expect(await hydrate(persist)).toEqual(hydrated);
    await persist.close();
  });
}

it("refuses to re-encode an unreadable descendant when healing has not succeeded", async () => {
  const root = await seed([
    [key(...prefix), JSON.stringify({ retained: mod })],
    [
      Buffer.concat([key(...prefix), Buffer.from("###"), Buffer.from([255]), Buffer.from("###id")]),
      '"bad"',
    ],
  ]);
  let persist = await open(root);
  const before = await persist.getAllKVs();
  await expect(normalizeStateBlobs(persist)).rejects.toThrow("unreadable keys");
  expect(await persist.getAllKVs()).toEqual(before);
  await persist.close();
  persist = await open(root);
  expect(await persist.getAllKVs()).toEqual(before);
  await healInvalidKeys(persist);
  await normalizeStateBlobs(persist);
  expect(await hydrate(persist)).toEqual({ mods: { skyrimse: { retained: mod } } });
  await persist.close();
});

for (const shape of ["array-property", "embedded-separator"]) {
  it(`preserves hydration when ${shape} uses compatible JSON rows`, async () => {
    const rows: Array<[Buffer, string]> =
      shape === "array-property"
        ? [
            [key(...prefix), '{"retained":{"tags":["one"]}}'],
            [key(...prefix, "retained", "tags", "custom"), '"extra"'],
          ]
        : [[key(...prefix), '{"retained":{"attributes":{"embedded###name":"keep"}}}']];
    const root = await seed(rows);
    let persist = await open(root);
    const hydrated = await hydrate(persist);
    await normalizeStateBlobs(persist);
    expect(await hydrate(persist)).toEqual(hydrated);
    const normalized = await persist.getAllKVs();
    await persist.close();
    persist = await open(root);
    expect(await persist.getAllKVs()).toEqual(normalized);
    expect(await hydrate(persist)).toEqual(hydrated);
    await persist.close();
  });
}

for (const name of ["bad\uFFFDname", "bad\u0001name", "bad\ud800name"]) {
  it(`normalization preserves special JSON object key ${JSON.stringify(name)}`, async () => {
    const root = await seed([
      [
        key(...prefix),
        JSON.stringify({
          retained: { ...mod, attributes: { name: "valid", [name]: "independent attribute" } },
        }),
      ],
    ]);
    let persist = await open(root);
    const before = await hydrate(persist);
    await normalizeStateBlobs(persist);
    expect(await hydrate(persist)).toEqual(before);
    await persist.close();
    persist = await open(root);
    await healInvalidKeys(persist);
    const rewrite = vi.spyOn(persist, "replaceRawRows");
    await normalizeStateBlobs(persist);
    expect(rewrite).not.toHaveBeenCalled();
    expect(await hydrate(persist)).toEqual(before);
    await persist.close();
  });
}

it("an array row with existing numeric descendants accepts subsequent whole-array updates", async () => {
  const root = await seed([
    [key("persistent", "review", "list"), '[{"name":"blob"}]'],
    [key("persistent", "review", "list", "0", "name"), '"child override"'],
  ]);
  let persist = await open(root);
  const before = await hydrate(persist);
  await normalizeStateBlobs(persist);
  expect(await hydrate(persist)).toEqual(before);
  const ipc = new ReduxPersistorIPC();
  ipc.setQueryInvalidator(persist, { notifyDirtyTables: () => {} } as unknown as QueryInvalidator);
  await ipc.insertPersistor("persistent", new SubPersistor(persist, "persistent"));
  const { computeStateDiff } = (await import(
    path.resolve(import.meta.dirname, "../../../renderer/src/store/stateDiff.ts")
  )) as { computeStateDiff: (before: unknown, after: unknown) => DiffOperation[] };
  const expected = { review: { list: [{ name: "updated" }] } };
  const operations = computeStateDiff(before, expected);
  expect(operations).toEqual([
    { type: "set", path: ["review", "list"], value: [{ name: "updated" }] },
  ]);
  ipc.applyDiffOperations("persistent", operations);
  await ipc.finalizeWrite();
  await persist.close();
  persist = await open(root);
  const after = await hydrate(persist);
  expect(after).toEqual(expected);
  await healInvalidKeys(persist);
  await normalizeStateBlobs(persist);
  const again = new ReduxPersistorIPC();
  again.setQueryInvalidator(persist, {
    notifyDirtyTables: () => {},
  } as unknown as QueryInvalidator);
  await again.insertPersistor("persistent", new SubPersistor(persist, "persistent"));
  const final = { review: { list: [{ name: "second update" }] } };
  again.applyDiffOperations("persistent", computeStateDiff(after, final));
  await again.finalizeWrite();
  await persist.close();
  persist = await open(root);
  expect(await hydrate(persist)).toEqual(final);
  await persist.close();
});

it("unsafe attributes and supported mod groups normalize together without data loss", async () => {
  const root = await seed([
    [key("persistent", "mods", "fallout4"), JSON.stringify({ retained: mod })],
    [
      key(...prefix),
      JSON.stringify({ retained: { ...mod, attributes: { "bad\u0001name": "keep" } } }),
    ],
  ]);
  let persist = await open(root);
  const before = await hydrate(persist);
  await normalizeStateBlobs(persist);
  await persist.close();
  persist = await open(root);
  expect(await hydrate(persist)).toEqual(before);
  await persist.close();
});

for (const action of ["remove", "update"]) {
  for (const boundary of ["after-delete", "first-insert", "second-insert", "before-commit"]) {
    it(`ancestor ${action} rolls back native rows at ${boundary} and can write later`, async () => {
      const attributes = Object.fromEntries(
        Array.from({ length: 300 }, (_, i) => [`field${i}`, i]),
      );
      const root = await seed([
        [key(...prefix), JSON.stringify({ retained: { ...mod, attributes }, sibling: mod })],
        [key(...prefix, "retained", "attributes", "field0"), "900"],
        [key("settings", "window", "width"), " 800 "],
      ]);
      let persist = await open(root);
      const original = await persist.getAllKVs();
      const before = await hydrate(persist);
      const run = persist.connection.run.bind(persist.connection);
      let inserts = 0;
      vi.spyOn(persist.connection, "run").mockImplementation(async (sql, ...args) => {
        if (sql.startsWith("INSERT")) inserts++;
        if (
          (boundary === "second-insert" && sql.startsWith("INSERT") && inserts === 2) ||
          (boundary === "before-commit" && sql === "COMMIT")
        )
          throw new Error("ancestor write boundary");
        const result = await run(sql, ...args);
        if (
          (boundary === "after-delete" && sql.startsWith("DELETE")) ||
          (boundary === "first-insert" && sql.startsWith("INSERT"))
        )
          throw new Error("ancestor write boundary");
        return result;
      });
      const target = [...prefix, "retained", "attributes", "field0"];
      await expect(
        action === "remove" ? persist.removeItem(target) : persist.setItem(target, "901"),
      ).rejects.toThrow("ancestor write boundary");
      vi.restoreAllMocks();
      expect(await persist.getAllKVs()).toEqual(original);
      await persist.close();
      persist = await open(root);
      expect(await persist.getAllKVs()).toEqual(original);
      expect(await hydrate(persist)).toEqual(before);
      if (action === "remove") await persist.removeItem(target);
      else await persist.setItem(target, "901");
      const expected = structuredClone(before) as {
        mods: Record<string, Record<string, { attributes: Record<string, unknown> }>>;
      };
      if (action === "remove") delete expected.mods.skyrimse!.retained!.attributes.field0;
      else expected.mods.skyrimse!.retained!.attributes.field0 = 901;
      await persist.close();
      persist = await open(root);
      expect(await hydrate(persist)).toEqual(expected);
      expect(await persist.getItem(["settings", "window", "width"])).toBe(" 800 ");
      await persist.close();
    });
  }
}

for (const action of ["ancestor-remove", "ancestor-update"]) {
  for (const boundary of ["after-delete", "partial-reinsert", "after-commit"]) {
    it(`SIGKILL at ${action} ${boundary} recovers the native transaction`, async () => {
      const root = await seed([
        [key(...prefix), JSON.stringify({ retained: mod, sibling: mod })],
        [key(...prefix, "retained", "attributes", "name"), '"child override"'],
        [key("settings", "window", "width"), " 800 "],
      ]);
      const compiled = await compilePersistence();
      let persist = await open(root);
      const original = await persist.getAllKVs();
      const before = await hydrate(persist);
      await persist.close();
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, "normalizeStateBlobs.process.fixture.cjs"),
          root,
          ext,
          compiled,
          path.resolve(import.meta.dirname, "../../package.json"),
          boundary,
          action,
        ],
        { encoding: "utf8", timeout: 20000, env: { ...process.env, NODE_OPTIONS: "" } },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal, JSON.stringify(result)).toBe("SIGKILL");
      expect(result.stdout).toBe(boundary);
      expect(result.stderr).toBe("");
      persist = await open(root);
      const expected = structuredClone(before) as {
        mods: Record<string, Record<string, { attributes: Record<string, unknown> }>>;
      };
      if (boundary === "after-commit") {
        if (action === "ancestor-remove") delete expected.mods.skyrimse!.retained;
        else expected.mods.skyrimse!.retained!.attributes.name = "Updated";
      } else expect(await persist.getAllKVs()).toEqual(original);
      expect(await hydrate(persist)).toEqual(expected);
      await normalizeStateBlobs(persist);
      expect(await hydrate(persist)).toEqual(expected);
      await persist.close();
    });
  }
}

it("keeps literal separators, terminal hashes, own names and adjacent paths distinct through writes", async () => {
  const attributes = JSON.parse(
    '{"literal###name":"literal","literal":{"name":"nested"},"edge#":{"child":"hash"},"edge":{"#child":"neighbor"},"__proto__":{"keep":true},"constructor":{"prototype":{"keep":true}},"":"empty","nil":null}',
  ) as Record<string, unknown>;
  const root = await seed([[key(...prefix), JSON.stringify({ retained: { ...mod, attributes } })]]);
  let persist = await open(root);
  await normalizeStateBlobs(persist);
  const target = [...prefix, "retained", "attributes"];
  await persist.setItem([...target, "literal###name"], '"updated"');
  await persist.removeItem([...target, "edge#"]);
  await persist.setItem([...target, "new\u0001name"], '"new"');
  await persist.setItem([...target, "__proto__", "keep"], "false");
  const expected = {
    mods: {
      skyrimse: {
        retained: {
          ...mod,
          attributes: { ...attributes, "literal###name": "updated", "new\u0001name": "new" },
        },
      },
    },
  };
  Reflect.deleteProperty(expected.mods.skyrimse.retained.attributes, "edge#");
  Object.defineProperty(expected.mods.skyrimse.retained.attributes, "__proto__", {
    value: { keep: false },
    enumerable: true,
  });
  expect(Object.hasOwn(Object.prototype, "keep")).toBe(false);
  await persist.close();
  persist = await open(root);
  await healInvalidKeys(persist);
  await normalizeStateBlobs(persist);
  expect(await hydrate(persist)).toEqual(expected);
  expect(await persist.readStateValue([...target, "literal###name"])).toBe("updated");
  expect(await persist.readStateValue([...target, "literal", "name"])).toBe("nested");
  await persist.close();
});

it("serializes concurrent ancestor writers and rolls back only the failed transaction", async () => {
  const root = await seed([[key(...prefix), JSON.stringify({ retained: mod, sibling: mod })]]);
  let persist = await open(root);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const order: string[] = [];
  const startLater = Promise.withResolvers<void>();
  let second: Promise<void>;
  await persist.withTransaction(() => {
    // The callback inherits this completed transaction's async context.
    second = startLater.promise.then(async () => {
      await persist.setItem([...prefix, "sibling", "attributes", "name"], '"committed"');
      order.push("commit");
    });
    return Promise.resolve();
  });
  const first = persist.withTransaction(async () => {
    await persist.setItem([...prefix, "retained", "attributes", "name"], '"discarded"');
    entered.resolve();
    await gate.promise;
    order.push("rollback");
    throw new Error("first writer failed");
  });
  await entered.promise;
  startLater.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  gate.resolve();
  await expect(first).rejects.toThrow("first writer failed");
  await second!;
  expect(order).toEqual(["rollback", "commit"]);
  await persist.close();
  persist = await open(root);
  expect(await persist.readStateValue([...prefix, "retained", "attributes", "name"])).toBe(
    "Original",
  );
  expect(await persist.readStateValue([...prefix, "sibling", "attributes", "name"])).toBe(
    "committed",
  );
  await persist.close();
});

it("preserves readable terminal-hash rows and their distinct encoded neighbors", async () => {
  const root = await seed([
    [key("persistent", "section#"), ' {"child":{"value":"keep"},"other":null} '],
    [key("persistent", "section", "#neighbor"), ' "untouched" '],
  ]);
  let persist = await open(root);
  const before = await hydrate(persist);
  await normalizeStateBlobs(persist);
  expect(await hydrate(persist)).toEqual(before);
  await persist.setItem(["persistent", "section#", "child", "value"], '"updated"');
  expect(await persist.readStateValue(["persistent", "section#", "child", "value"])).toBe(
    "updated",
  );
  await persist.removeItem(["persistent", "section#", "child"]);
  await persist.close();
  persist = await open(root);
  expect(await hydrate(persist)).toEqual({
    "section#": { other: null },
    section: { "#neighbor": "untouched" },
  });
  await persist.removeItem(["persistent", "section#"]);
  expect(await persist.getItem(["persistent", "section", "#neighbor"])).toBe(' "untouched" ');
  await persist.close();
});

it("healing preserves native parent and child bytes through raw replacement and reopen", async () => {
  const original = [
    [key(...prefix), ' {"retained":{"id":"retained"}} '],
    [key(...prefix, "healthy", "id"), ' "healthy" '],
    [key("settings", "window", "width"), " 800 "],
  ] as Array<[Buffer, string]>;
  const root = await seed([
    ...original,
    [
      Buffer.concat([
        key(...prefix),
        Buffer.from("###bad"),
        Buffer.from([255]),
        Buffer.from("###id"),
      ]),
      '"bad"',
    ],
  ]);
  let persist = await open(root);
  expect((await healInvalidKeys(persist)).removed).toBe(1);
  const expected = original.map(([name, value]) => ({ key: name.toString().split("###"), value }));
  expect(await persist.getAllKVs()).toEqual(expected);
  await persist.close();
  persist = await open(root);
  expect(await persist.getAllKVs()).toEqual(expected);
  expect((await healInvalidKeys(persist)).removed).toBe(0);
  await persist.close();
});

it("an unreadable raw group rolls back previously rewritten supported groups", async () => {
  const root = await seed([
    [key("persistent", "alpha"), '{"retained":{"id":"first"}}'],
    [key(...prefix), JSON.stringify({ retained: mod })],
    [
      Buffer.concat([
        key(...prefix),
        Buffer.from("###bad"),
        Buffer.from([255]),
        Buffer.from("###id"),
      ]),
      '"bad"',
    ],
  ]);
  let persist = await open(root);
  const original = await persist.getAllKVs();
  await expect(normalizeStateBlobs(persist)).rejects.toThrow("unreadable keys");
  await persist.close();
  persist = await open(root);
  expect(await persist.getAllKVs()).toEqual(original);
  await persist.close();
});

it("preserves a named array property ending in a hash across startup and changes", async () => {
  const root = await seed([
    [key(...prefix), '{"retained":{"tags":["one"]}}'],
    [key(...prefix, "retained", "tags", "custom#"), '{"name":"extra"}'],
  ]);
  let persist = await open(root);
  const before = await hydrate(persist);
  await normalizeStateBlobs(persist);
  expect(await hydrate(persist)).toEqual(before);
  await persist.setItem([...prefix, "retained", "tags", "custom#", "name"], '"updated"');
  await persist.close();
  persist = await open(root);
  await normalizeStateBlobs(persist);
  expect(await persist.readStateValue([...prefix, "retained", "tags", "custom#", "name"])).toBe(
    "updated",
  );
  await persist.removeItem([...prefix, "retained", "tags", "custom#"]);
  expect(await hydrate(persist)).toEqual({ mods: { skyrimse: { retained: { tags: ["one"] } } } });
  await persist.close();
});
