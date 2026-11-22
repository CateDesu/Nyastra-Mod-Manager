import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DiffOperation } from "@vortex/shared/ipc";
import { afterEach, expect, it, vi } from "vitest";

import DuckDBSingleton from "./DuckDBSingleton";
import LevelPersist from "./LevelPersist";
import {
  closeMainPersistence,
  initMainPersistence,
  readPersistedValue,
  writePersistedValue,
} from "./mainPersistence";
type HydrationResponse = { data: { settings: { window: { width: number } } } };
type Handle = (event: { senderFrame: null }) => Promise<HydrationResponse>;
type DiffHandler = (
  event: { senderFrame: null },
  hive: string,
  operations: DiffOperation[],
) => void;
const fixture = vi.hoisted(() => ({
  handles: new Map<string, Handle>(),
  events: new Map<string, DiffHandler>(),
  errors: [] as string[],
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (c: string, fn: Handle) => fixture.handles.set(c, fn),
    on: (c: string, fn: DiffHandler) => fixture.events.set(c, fn),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../logging", () => ({
  log: (_level: string, _message: string, data?: { error?: unknown }) => {
    if (typeof data?.error === "string") fixture.errors.push(data.error);
  },
}));
vi.mock("../errorHandling", () => ({
  terminate: (error: Error) => {
    throw error;
  },
}));
vi.mock("../getVortexPath", () => ({ getVortexPath: () => "/nonexistent-synthetic-base" }));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeMainPersistence();
  DuckDBSingleton.getInstance().close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  fixture.handles.clear();
  fixture.events.clear();
  fixture.errors = [];
});
async function open(root: string) {
  const s = DuckDBSingleton.getInstance();
  await s.initialize(path.resolve(import.meta.dirname, "../../build/duckdb-extensions"));
  const alias = s.nextAlias();
  return new LevelPersist(await s.attachDatabase(root, alias), alias);
}
async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "review-hydration-"));
  roots.push(root);
  const persist = await open(root);
  await persist.setItem(["settings", "window", "width"], "800");
  const ipc = initMainPersistence(persist);
  return { persist, ipc, root };
}
const event = { senderFrame: null };
it("hydration requested after a queued diff waits for its failure and returns original", async () => {
  const { persist, ipc } = await setup();
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const run = persist.connection.run.bind(persist.connection);
  let pause = true;
  vi.spyOn(persist.connection, "run").mockImplementation(async (sql, ...args) => {
    if (pause && sql === "COMMIT") {
      pause = false;
      entered.resolve();
      await resume.promise;
      throw new Error("synthetic COMMIT rejection");
    }
    return run(sql, ...args);
  });
  fixture.events.get("persist:diff")!(event, "settings", [
    { type: "set", path: ["window", "width"], value: 1200 },
  ]);
  await entered.promise;
  let settled = false;
  const hydration = fixture.handles.get("persist:get-hydration")!(event).then((r) => {
    settled = true;
    return r;
  });
  try {
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
  } finally {
    resume.resolve();
    await ipc.finalizeWrite();
  }
  expect((await hydration).data.settings.window.width).toBe(800);
});

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "hydration orders later writers and rollback, rollback %s direct %s",
  async (rollback, direct) => {
    const { persist, ipc } = await setup();
    const enumerated = Promise.withResolvers<void>(),
      resumeEnumeration = Promise.withResolvers<void>(),
      beforeCommit = Promise.withResolvers<void>(),
      resumeCommit = Promise.withResolvers<void>();
    const read = persist.connection.runAndReadAll.bind(persist.connection),
      run = persist.connection.run.bind(persist.connection);
    let pauseRead = true,
      pauseCommit = true,
      commitEntered = false;
    vi.spyOn(persist.connection, "runAndReadAll").mockImplementation(async (sql, ...args) => {
      const r = await read(sql, ...args);
      if (pauseRead && sql.includes("SELECT DISTINCT")) {
        pauseRead = false;
        enumerated.resolve();
        await resumeEnumeration.promise;
      }
      return r;
    });
    vi.spyOn(persist.connection, "run").mockImplementation(async (sql, ...args) => {
      if (pauseCommit && sql === "COMMIT") {
        pauseCommit = false;
        commitEntered = true;
        beforeCommit.resolve();
        await resumeCommit.promise;
        if (rollback) throw new Error("synthetic COMMIT rejection");
      }
      return run(sql, ...args);
    });
    let later: Promise<void> | undefined;
    const hydration = fixture.handles.get("persist:get-hydration")!(event);
    try {
      await enumerated.promise;
      later = direct ? writePersistedValue("settings", ["window", "width"], 1200) : undefined;
      if (!direct)
        fixture.events.get("persist:diff")!(event, "settings", [
          { type: "set", path: ["window", "width"], value: 1200 },
        ]);
      await new Promise((r) => setTimeout(r, 20));
      expect(commitEntered).toBe(false);
      resumeEnumeration.resolve();
      const response = structuredClone(await hydration);
      expect(response.data.settings.window.width).toBe(800);
      await beforeCommit.promise;
    } finally {
      resumeEnumeration.resolve();
      resumeCommit.resolve();
      await ipc.finalizeWrite();
      await later;
    }
    expect(await readPersistedValue("settings", ["window", "width"])).toBe(rollback ? 800 : 1200);
    const dbRoot = roots.at(-1)!;
    await closeMainPersistence();
    const reopened = await open(dbRoot);
    expect(await reopened.readStateValue(["settings", "window", "width"])).toBe(
      rollback ? 800 : 1200,
    );
    if (rollback) expect(fixture.errors.join(" ")).toContain("synthetic COMMIT rejection");
    initMainPersistence(reopened);
    fixture.events.get("persist:diff")!(event, "settings", [
      { type: "set", path: ["window", "width"], value: 1400 },
    ]);
    expect(
      (await fixture.handles.get("persist:get-hydration")!(event)).data.settings.window.width,
    ).toBe(1400);
  },
);
