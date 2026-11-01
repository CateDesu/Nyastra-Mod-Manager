import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DiffOperation } from "@vortex/shared/ipc";
import type { PersistedHive } from "@vortex/shared/state";
import { applyMiddleware, createStore, type Middleware, type Reducer } from "redux";
import { afterEach, beforeAll, expect, it } from "vitest";

import DuckDBSingleton from "./DuckDBSingleton";
import { flattenState } from "./flattenState";
import LevelPersist from "./LevelPersist";
import ReduxPersistorIPC from "./ReduxPersistorIPC";
import SubPersistor from "./SubPersistor";

const directories: string[] = [];
type PersistApi = { sendDiff: (hive: PersistedHive, operations: DiffOperation[]) => void };
type RendererPersistence = {
  createPersistDiffMiddleware: (getApi: () => PersistApi) => Middleware;
  flushPendingDiffsSync: () => void;
};
let createPersistDiffMiddleware: RendererPersistence["createPersistDiffMiddleware"];
let flushPendingDiffsSync: () => void;

beforeAll(async () => {
  // Load renderer source across the separate TypeScript programs.
  ({ createPersistDiffMiddleware, flushPendingDiffsSync } = (await import(
    path.resolve(import.meta.dirname, "../../../renderer/src/store/persistDiffMiddleware.ts")
  )) as RendererPersistence);
});
afterEach(() => {
  DuckDBSingleton.getInstance().close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const cases: Array<Array<Record<string, unknown>>> = [
  [{ attribute: { obsolete: true } }, { attribute: "current" }],
  [{ attribute: { obsolete: true } }, { attribute: ["current"] }],
  [{ attribute: { obsolete: true } }, { attribute: null }],
  [{ attribute: "previous" }, { attribute: { current: true } }],
  [{ attribute: ["previous"] }, { attribute: { current: true } }],
  [{ attribute: null }, { attribute: { current: true } }],
  [
    { attribute: { obsolete: true } },
    { attribute: ["intermediate"] },
    { attribute: { current: true } },
  ],
  [{}, Object.fromEntries([["__proto__", { id: "special" }]])],
  [Object.fromEntries([["__proto__", { id: "special" }]]), { ordinary: true }],
  [
    { profiles: { p: { name: "Saved selection", modState: { enabled: { enabled: true } } } } },
    {
      profiles: {
        p: {
          name: "Saved selection",
          modState: { enabled: { enabled: false } },
          enabledModsBeforeDisable: ["enabled"],
        },
      },
    },
  ],
  [
    {
      profiles: {
        p: {
          name: "Saved selection",
          modState: { enabled: { enabled: false }, manual: { enabled: true } },
          enabledModsBeforeDisable: ["enabled"],
        },
      },
    },
    {
      profiles: {
        p: {
          name: "Saved selection",
          modState: { enabled: { enabled: true }, manual: { enabled: true } },
        },
      },
    },
  ],
];

for (const flushEach of [false, true]) {
  it.each(cases.map((states, index) => ({ states, index })))(
    `round-trips state sequence $index through real middleware and database with flushEach=${flushEach}`,
    async ({ states }) => {
      const directory = mkdtempSync(path.join(tmpdir(), "nyastra-diff-roundtrip-"));
      directories.push(directory);
      const singleton = DuckDBSingleton.getInstance();
      await singleton.initialize(
        path.resolve(import.meta.dirname, "../../build/duckdb-extensions"),
      );
      const open = async () => {
        const alias = singleton.nextAlias();
        return new LevelPersist(await singleton.attachDatabase(directory, alias), alias);
      };
      const original = await open();
      const persistor = new ReduxPersistorIPC();
      await persistor.insertPersistor("persistent", new SubPersistor(original, "persistent"));
      for (const leaf of flattenState(states[0], ["persistent"])) {
        await original.setItem(leaf.key, JSON.stringify(leaf.value));
      }
      const reducer: Reducer<
        { persistent: Record<string, unknown> },
        { type: string; payload?: Record<string, unknown> }
      > = (state = { persistent: states[0]! }, action) =>
        action.type === "UPDATE" && action.payload !== undefined
          ? { persistent: action.payload }
          : state;
      const store = createStore(
        reducer,
        applyMiddleware(
          createPersistDiffMiddleware(() => ({
            sendDiff: (hive, operations) => persistor.applyDiffOperations(hive, operations),
          })),
        ),
      );
      store.dispatch({ type: "INIT" });
      for (const state of states.slice(1)) {
        store.dispatch({ type: "UPDATE", payload: state });
        if (flushEach) flushPendingDiffsSync();
      }
      flushPendingDiffsSync();
      await persistor.finalizeWrite();
      await original.close();
      const reopened = await open();
      const loaded = await new ReduxPersistorIPC().insertPersistor(
        "persistent",
        new SubPersistor(reopened, "persistent"),
      );
      expect(loaded).toEqual(states.at(-1));
      await reopened.close();
    },
  );
}
