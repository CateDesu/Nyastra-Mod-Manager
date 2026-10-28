import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DiffOperation } from "@vortex/shared/ipc";
import { afterEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  base: "",
}));
vi.mock("electron", () => ({
  ipcMain: {
    on: (name: string, callback: (...args: unknown[]) => unknown) =>
      transport.listeners.set(name, callback),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../ipc", () => ({
  betterIpcMain: {
    on: (name: string, callback: (...args: unknown[]) => unknown) =>
      transport.listeners.set(name, callback),
    handle: (name: string, callback: (...args: unknown[]) => unknown) =>
      transport.handlers.set(name, callback),
  },
}));
vi.mock("../getVortexPath", () => ({ getVortexPath: () => transport.base }));
vi.mock("../errorHandling", () => ({
  terminate: (error: Error) => {
    throw error;
  },
}));
vi.mock("../logging", () => ({ log: vi.fn() }));

import DuckDBSingleton from "./DuckDBSingleton";
import LevelPersist from "./LevelPersist";
import { closeMainPersistence, initMainPersistence } from "./mainPersistence";

const roots: string[] = [];
afterEach(async () => {
  await closeMainPersistence();
  DuckDBSingleton.getInstance().close();
  vi.restoreAllMocks();
  transport.handlers.clear();
  transport.listeners.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("hydrates a reload after the previous renderer's queued final diff is written", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nyastra-ipc-reload-"));
  roots.push(root);
  transport.base = root;
  const singleton = DuckDBSingleton.getInstance();
  await singleton.initialize(path.resolve(import.meta.dirname, "../../build/duckdb-extensions"));
  const alias = singleton.nextAlias();
  const level = new LevelPersist(
    await singleton.attachDatabase(path.join(root, "state"), alias),
    alias,
  );
  await level.setItem(["persistent", "profiles", "p", "name"], '"Previous profile name"');
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const order: string[] = [];
  const bulkWrite = level.bulkSetItem.bind(level);
  vi.spyOn(level, "bulkSetItem").mockImplementation(async (items) => {
    entered.resolve();
    await gate.promise;
    await bulkWrite(items);
    order.push("write completed");
  });
  const persistor = initMainPersistence(level);
  const hydrate = transport.handlers.get("persist:get-hydration")!;
  const diff = transport.listeners.get("persist:diff-sync")!;
  expect(await hydrate({})).toEqual({
    persistent: { profiles: { p: { name: "Previous profile name" } } },
  });
  const discover = level.getPersistedHives.bind(level);
  vi.spyOn(level, "getPersistedHives").mockImplementation(() => {
    order.push("hydration read");
    return discover();
  });
  const event = { returnValue: undefined as unknown };
  const operations: DiffOperation[] = [
    { type: "set", path: ["profiles", "p", "name"], value: "Queued profile name" },
  ];
  diff(event, "persistent", operations);
  let reload: Promise<unknown> | undefined;
  let loaded: unknown;
  try {
    await entered.promise;
    expect(event.returnValue).toBe(true);
    reload = Promise.resolve(hydrate({}));
    expect(await level.getItem(["persistent", "profiles", "p", "name"])).toBe(
      '"Previous profile name"',
    );
  } finally {
    gate.resolve();
    await persistor.finalizeWrite();
    loaded = await reload;
  }
  expect(loaded).toEqual({ persistent: { profiles: { p: { name: "Queued profile name" } } } });
  expect(order).toEqual(["write completed", "hydration read"]);
});
