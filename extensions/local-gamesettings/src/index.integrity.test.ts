import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { types } from "@nexusmods/vortex-api";
import Bluebird from "bluebird";
import { afterEach, expect, it, vi } from "vitest";

interface SettingsFixture {
  documents: string;
  userData: string;
  work: PromiseLike<unknown>[];
  copies: Array<{ source: string; destination: string; error?: NodeJS.ErrnoException }>;
  missingDestination: boolean;
  stats: Array<{ file: string; error?: NodeJS.ErrnoException }>;
  statWork: PromiseLike<unknown>[];
  native: Set<PromiseLike<unknown>>;
  callbacks: Set<PromiseLike<unknown>>;
  unlinkError?: NodeJS.ErrnoException;
  copyError?: (error: unknown) => PromiseLike<never>;
  statError?: (file: string, error: NodeJS.ErrnoException) => PromiseLike<never>;
  forwardStat?: (file: string, operation: PromiseLike<unknown>) => PromiseLike<unknown>;
}

const fixture = vi.hoisted<SettingsFixture>(() => ({
  documents: "",
  userData: "",
  work: [],
  copies: [],
  missingDestination: false,
  stats: [],
  statWork: [],
  native: new Set<PromiseLike<unknown>>(),
  callbacks: new Set<PromiseLike<unknown>>(),
  copyError: undefined,
  statError: undefined,
  forwardStat: undefined,
}));

vi.mock("@nexusmods/vortex-api", async () => {
  const nodeModule = await import("node:module");
  const nodePath = await import("node:path");
  const rendererRequire = nodeModule.createRequire(
    nodePath.resolve(import.meta.dirname, "../../../src/renderer/package.json"),
  );
  const temporal = await vi.importActual<{ install: () => void }>(
    rendererRequire.resolve("temporal-polyfill/shim"),
  );
  temporal.install();
  const native = rendererRequire("fs-extra");
  const { default: PromiseBB } = await import("bluebird");
  const filesystem = {
    copyAsync: (source: string, destination: string, options: any) =>
      PromiseBB.resolve(native.copy(source, destination, options)),
    statAsync: (file: string) => PromiseBB.resolve(native.stat(file)),
  };
  const { makeOverlayableDictionary } = await vi.importActual<any>(
    "../../../src/renderer/src/util/util",
  );
  const { getSafe } = await vi.importActual<any>("../../../src/renderer/src/util/storeHelper");
  const errors = await vi.importActual<any>("../../../src/shared/src/api/errors");
  return {
    fs: {
      ...filesystem,
      unlinkAsync: (file: string) => {
        const original = fixture.unlinkError
          ? PromiseBB.reject(fixture.unlinkError)
          : native.unlink(file);
        fixture.native.add(original);
        const operation = PromiseBB.resolve(original).finally(() =>
          fixture.native.delete(original),
        );
        fixture.callbacks.add(operation);
        const settled = operation.then(
          () => fixture.callbacks.delete(operation),
          () => fixture.callbacks.delete(operation),
        );
        fixture.work.push(original, operation, settled);
        return operation;
      },
      statAsync: (file: string) => {
        const record: SettingsFixture["stats"][number] = { file };
        fixture.stats.push(record);
        const original = filesystem.statAsync(file);
        fixture.native.add(original);
        const delivered = original.then(
          (result) => {
            fixture.native.delete(original);
            return result;
          },
          (error: NodeJS.ErrnoException) => {
            fixture.native.delete(original);
            record.error = error;
            return fixture.statError?.(file, error) ?? PromiseBB.reject(error);
          },
        );
        const operation: PromiseLike<unknown> = fixture.forwardStat?.(file, delivered) ?? delivered;
        fixture.callbacks.add(operation);
        const settled = operation.then(
          () => fixture.callbacks.delete(operation),
          () => fixture.callbacks.delete(operation),
        );
        fixture.statWork.push(original, operation, settled);
        fixture.work.push(original, operation, settled);
        return operation;
      },
      copyAsync: (source: string, destination: string, options: unknown) => {
        const record: SettingsFixture["copies"][number] = { source, destination };
        fixture.copies.push(record);
        const operation = PromiseBB.resolve()
          .then(() => {
            if (fixture.missingDestination && source.includes(`${path.sep}profiles${path.sep}`)) {
              throw Object.assign(new Error("Destination parent disappeared"), { code: "ENOENT" });
            }
            return filesystem.copyAsync(source, destination, options);
          })
          .catch((error) => fixture.copyError?.(error) ?? PromiseBB.reject(error))
          .catch((error: NodeJS.ErrnoException) => {
            record.error = error;
            throw error;
          });
        fixture.work.push(operation);
        operation.catch(() => undefined);
        return operation;
      },
    },
    log: vi.fn<(...args: unknown[]) => void>(),
    selectors: {
      discoveryByGame: (state: any, game: string) => state.settings.gameMode.discovered[game],
      activeGameId: (state: any) =>
        state.persistent.profiles[state.settings.profiles.activeProfileId]?.gameId,
      activeProfile: (state: any) =>
        state.persistent.profiles[state.settings.profiles.activeProfileId],
      lastActiveProfileForGame: () => undefined,
    },
    util: {
      getVortexPath: (key: "documents" | "userData") => fixture[key],
      getSafe,
      makeOverlayableDictionary,
      unique: (values: any[], key: (value: any) => string) =>
        values.filter(
          (value, index) => values.findIndex((other) => key(other) === key(value)) === index,
        ),
      sortMods: async (_game: string, mods: unknown[]) => mods,
      showError: vi.fn<(...args: unknown[]) => void>(),
      UserCanceled: errors.UserCanceled,
      CycleError: errors.CycleError,
    },
  };
});

import { util } from "@nexusmods/vortex-api";

import init from "./index";

const roots: string[] = [];
const permissions: Array<{ file: string; mode: number }> = [];

async function drain() {
  let count = -1;
  while (count !== fixture.work.length) {
    count = fixture.work.length;
    await Promise.allSettled(fixture.work);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(fixture.native.size).toBe(0);
  expect(fixture.callbacks.size).toBe(0);
}

async function readSettingsBytes(file: string) {
  return readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

afterEach(async () => {
  await drain();
  for (const entry of permissions.splice(0)) await chmod(entry.file, entry.mode);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  fixture.work = [];
  fixture.copies = [];
  fixture.stats = [];
  fixture.statWork = [];
  fixture.copyError = undefined;
  fixture.statError = undefined;
  fixture.forwardStat = undefined;
  fixture.missingDestination = false;
  fixture.unlinkError = undefined;
  vi.clearAllMocks();
});

it.each([
  "normal",
  "first-use",
  "denied-destination",
  "denied-source",
  "denied-optional",
  "missing-destination",
])("preserves profile settings through the public event with %s", async (mode) => {
  const root = await mkdtemp(path.join(tmpdir(), "nyastra-settings-integrity-"));
  roots.push(root);
  fixture.documents = path.join(root, "documents");
  fixture.userData = path.join(root, "data");
  const game = path.join(fixture.documents, "My Games", "Skyrim Special Edition");
  const profile = path.join(fixture.userData, "skyrimse", "profiles", "target");
  await Promise.all([game, profile].map((directory) => mkdir(directory, { recursive: true })));
  const required = ["Skyrim.ini", "SkyrimPrefs.ini"];
  const files = mode === "denied-optional" ? [...required, "SkyrimCustom.ini"] : required;
  for (const file of files) {
    await writeFile(path.join(game, file), "live " + file);
    await writeFile(path.join(game, file + ".base"), "global " + file);
    if (mode !== "first-use") await writeFile(path.join(profile, file), "saved " + file);
  }
  if (mode === "denied-destination") {
    await chmod(game, 0o555);
    permissions.push({ file: game, mode: 0o755 });
  } else if (mode === "denied-source" || mode === "denied-optional") {
    const file = path.join(profile, mode === "denied-source" ? required[0] : "SkyrimCustom.ini");
    await chmod(file, 0o000);
    permissions.push({ file, mode: 0o644 });
  }
  fixture.missingDestination = mode === "missing-destination";
  const state = {
    settings: {
      profiles: { activeProfileId: undefined },
      gameMode: { discovered: { skyrimse: { store: "steam" } } },
    },
    persistent: {
      profiles: {
        target: { id: "target", gameId: "skyrimse", features: { local_game_settings: true } },
      },
      mods: { skyrimse: {} },
    },
  };
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const context = {
    api: {
      store: { getState: () => state, dispatch: vi.fn<(...args: unknown[]) => void>() },
      getState: () => state,
      events: {
        on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
      },
      emitAndAwait: vi.fn<() => Promise<void>>(async () => undefined),
      showErrorNotification: vi.fn<(...args: unknown[]) => void>(),
    },
    registerProfileFeature: vi.fn<(...args: unknown[]) => void>(),
    registerTest: vi.fn<(...args: unknown[]) => void>(),
    once: (callback: () => void) => callback(),
  };
  expect(init(context as unknown as types.IExtensionContext)).toBe(true);
  const queue: Array<() => PromiseLike<unknown>> = [];
  handlers.get("profile-will-change")("target", (callback: () => PromiseLike<unknown>) =>
    queue.push(callback),
  );
  expect(queue).toHaveLength(1);
  const operation = queue.shift()();
  fixture.work.push(operation);
  await operation;
  await drain();
  expect(queue).toEqual([]);
  expect(context.api.emitAndAwait).toHaveBeenCalledTimes(1);
  expect(context.api.showErrorNotification).not.toHaveBeenCalled();
  const failed = mode !== "normal" && mode !== "first-use";
  expect.soft(util.showError).toHaveBeenCalledTimes(failed ? 1 : 0);
  if (mode.startsWith("denied")) {
    expect(fixture.copies.some((entry) => entry.error?.code === "EACCES")).toBe(true);
  }
  if (failed) {
    expect
      .soft(fixture.copies.filter((entry) => entry.destination.startsWith(profile)))
      .toEqual([]);
  }
  // Restore read permissions only after all native copies have settled.
  for (const entry of permissions.splice(0)) await chmod(entry.file, entry.mode);
  for (const file of files) {
    expect
      .soft(await readFile(path.join(profile, file), "utf8"))
      .toBe(mode === "first-use" ? "global " + file : "saved " + file);
    if (!failed) {
      const expected = mode === "first-use" ? "global " + file : "saved " + file;
      expect(await readFile(path.join(game, file), "utf8")).toBe(expected);
      expect(await readFile(path.join(game, file + ".base"), "utf8")).toBe(expected);
      expect(await readFile(path.join(game, file + ".baked"), "utf8")).toBe(expected);
    }
  }
  if (mode === "normal" || mode === "first-use") {
    await expect(readFile(path.join(profile, "SkyrimCustom.ini"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});

it.each(["missing", "denied"])("preserves outgoing global backups when %s", async (mode) => {
  const root = await mkdtemp(path.join(tmpdir(), "nyastra-settings-backup-"));
  roots.push(root);
  fixture.documents = path.join(root, "documents");
  fixture.userData = path.join(root, "data");
  const game = path.join(fixture.documents, "My Games", "Skyrim Special Edition");
  const backup = path.join(fixture.userData, "skyrimse");
  const profile = path.join(backup, "profiles", "old");
  await Promise.all([game, profile].map((directory) => mkdir(directory, { recursive: true })));
  const files = ["Skyrim.ini", "SkyrimPrefs.ini"];
  for (const file of files) {
    await writeFile(path.join(game, file), "live " + file);
    await writeFile(path.join(game, file + ".base"), "current " + file);
    if (mode === "denied") await writeFile(path.join(backup, file), "backup " + file);
  }
  if (mode === "denied") {
    await chmod(game, 0o555);
    permissions.push({ file: game, mode: 0o755 });
  }
  const state = {
    settings: {
      profiles: { activeProfileId: "old" },
      gameMode: { discovered: { skyrimse: { store: "steam" } } },
    },
    persistent: {
      profiles: {
        old: { id: "old", gameId: "skyrimse", features: { local_game_settings: true } },
        next: { id: "next", gameId: "skyrimse", features: { local_game_settings: false } },
      },
      mods: { skyrimse: {} },
    },
  };
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const context = {
    api: {
      store: { getState: () => state, dispatch: vi.fn<(...args: unknown[]) => void>() },
      getState: () => state,
      events: {
        on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
      },
      emitAndAwait: vi.fn<() => Promise<void>>(async () => undefined),
      showErrorNotification: vi.fn<(...args: unknown[]) => void>(),
    },
    registerProfileFeature: vi.fn<(...args: unknown[]) => void>(),
    registerTest: vi.fn<(...args: unknown[]) => void>(),
    once: (callback: () => void) => callback(),
  };
  expect(init(context as unknown as types.IExtensionContext)).toBe(true);
  const queue: Array<() => PromiseLike<unknown>> = [];
  handlers.get("profile-will-change")("next", (callback: () => PromiseLike<unknown>) =>
    queue.push(callback),
  );
  expect(queue).toHaveLength(1);
  const operation = queue.shift()();
  fixture.work.push(operation);
  await operation;
  await drain();
  expect(queue).toEqual([]);
  expect(context.api.emitAndAwait).toHaveBeenCalledTimes(2);
  expect(context.api.showErrorNotification).not.toHaveBeenCalled();
  expect.soft(util.showError).toHaveBeenCalledTimes(mode === "denied" ? 1 : 0);
  expect(fixture.copies.some((entry) => entry.error?.code === "EACCES")).toBe(mode === "denied");
  for (const file of files) {
    expect
      .soft(await readFile(path.join(backup, file), "utf8"))
      .toBe((mode === "denied" ? "backup " : "current ") + file);
    expect(await readFile(path.join(profile, file), "utf8")).toBe("current " + file);
    expect(await readFile(path.join(game, file), "utf8")).toBe(
      (mode === "denied" ? "live " : "current ") + file,
    );
  }
});

it("drains a held native sibling stat error before public failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nyastra-settings-stat-"));
  roots.push(root);
  fixture.documents = path.join(root, "documents");
  fixture.userData = path.join(root, "data");
  const game = path.join(fixture.documents, "My Games", "Skyrim Special Edition");
  const profile = path.join(fixture.userData, "skyrimse", "profiles", "target");
  await Promise.all([game, profile].map((directory) => mkdir(directory, { recursive: true })));
  const files = ["Skyrim.ini", "SkyrimPrefs.ini"];
  for (const file of files) {
    await writeFile(path.join(game, file), "live " + file);
    await writeFile(path.join(game, file + ".base"), "global " + file);
    await writeFile(path.join(profile, file), "saved " + file);
  }
  await chmod(game, 0o555);
  permissions.push({ file: game, mode: 0o755 });

  let release!: () => void;
  let admitted!: () => void;
  const gate = new Bluebird<void>((resolve) => {
    release = resolve;
  });
  const held = new Bluebird<void>((resolve) => {
    admitted = resolve;
  });
  const optional = path.join(profile, "SkyrimCustom.ini");
  let statError: NodeJS.ErrnoException | undefined;
  let pending = 0;
  let deliveries = 0;
  let firstDenied: unknown;
  fixture.statError = (file, error) => {
    if (file !== optional || statError !== undefined) return Bluebird.reject(error);
    statError = error;
    pending++;
    admitted();
    return gate.then(() => {
      pending--;
      deliveries++;
      throw error;
    });
  };
  fixture.copyError = (error) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EACCES")
      return Bluebird.reject(error);
    firstDenied ??= error;
    return held.then(() => {
      throw error;
    });
  };
  const state = {
    settings: {
      profiles: { activeProfileId: undefined },
      gameMode: { discovered: { skyrimse: { store: "steam" } } },
    },
    persistent: {
      profiles: {
        target: { id: "target", gameId: "skyrimse", features: { local_game_settings: true } },
      },
      mods: { skyrimse: {} },
    },
  };
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const context = {
    api: {
      store: { getState: () => state, dispatch: vi.fn<(...args: unknown[]) => void>() },
      getState: () => state,
      events: {
        on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
      },
      emitAndAwait: vi.fn<() => Promise<void>>(async () => undefined),
      showErrorNotification: vi.fn<(...args: unknown[]) => void>(),
    },
    registerProfileFeature: vi.fn<(...args: unknown[]) => void>(),
    registerTest: vi.fn<(...args: unknown[]) => void>(),
    once: (callback: () => void) => callback(),
  };
  expect(init(context as unknown as types.IExtensionContext)).toBe(true);
  const queue: Array<() => PromiseLike<unknown>> = [];
  let callbacks = 0;
  handlers.get("profile-will-change")("target", (callback: () => PromiseLike<unknown>) => {
    queue.push(() => {
      callbacks++;
      return callback();
    });
  });
  expect(queue).toHaveLength(1);
  const operation = queue.shift()();
  fixture.work.push(operation);
  let settled = false;
  const observed = Bluebird.resolve(operation).then(() => {
    settled = true;
    return undefined;
  });
  let pendingAtPublic: number | undefined;
  try {
    await held;
    await vi.waitFor(() => expect(firstDenied).toBeDefined());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(pending).toBe(1);
    expect(util.showError).not.toHaveBeenCalled();
    release();
    await observed;
    pendingAtPublic = pending;
  } finally {
    release();
    let count = -1;
    while (count !== fixture.statWork.length + fixture.work.length) {
      count = fixture.statWork.length + fixture.work.length;
      await Promise.allSettled([operation, ...fixture.statWork, ...fixture.work]);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await drain();
  }
  expect(settled).toBe(true);
  expect(pendingAtPublic).toBe(0);
  expect(pending).toBe(0);
  expect(deliveries).toBe(1);
  expect(fixture.native.size).toBe(0);
  expect(fixture.callbacks.size).toBe(0);
  expect(fixture.stats).toHaveLength(5);
  expect(fixture.statWork).toHaveLength(15);
  expect(fixture.stats.find((entry) => entry.file === optional)?.error).toBe(statError);
  expect(statError).toMatchObject({ code: "ENOENT", syscall: "stat", path: optional });
  expect(fixture.copies).toHaveLength(7);
  const denied = fixture.copies.filter((entry) => entry.error?.code === "EACCES");
  expect(denied).toHaveLength(2);
  expect(firstDenied).toMatchObject({ code: "EACCES", syscall: "unlink" });
  expect(denied.map((entry) => entry.error)).toContain(firstDenied);
  expect(util.showError).toHaveBeenCalledExactlyOnceWith(
    context.api.store.dispatch,
    "An error occurred applying game settings",
    expect.objectContaining({ error: firstDenied }),
  );
  expect(
    Object.getOwnPropertyDescriptor(vi.mocked(util.showError).mock.calls[0][2], "error")?.value,
  ).toBe(firstDenied);
  expect(context.api.emitAndAwait).toHaveBeenCalledTimes(1);
  expect(context.api.showErrorNotification).not.toHaveBeenCalled();
  expect(callbacks).toBe(1);
  expect(queue).toEqual([]);
  expect(fixture.copies.filter((entry) => entry.destination.startsWith(profile))).toEqual([]);
  for (const file of files) {
    expect(await readFile(path.join(profile, file), "utf8")).toBe("saved " + file);
    expect(await readFile(path.join(game, file), "utf8")).toBe("live " + file);
    expect(await readFile(path.join(game, file + ".base"), "utf8")).toBe("global " + file);
  }
  await expect(readFile(optional)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  {
    originalPresent: false,
    targetLocal: false,
    targetOptional: false,
    privatePresent: true,
    denied: false,
  },
  {
    originalPresent: true,
    targetLocal: false,
    targetOptional: false,
    privatePresent: true,
    denied: false,
  },
  {
    originalPresent: false,
    targetLocal: true,
    targetOptional: false,
    privatePresent: true,
    denied: false,
  },
  {
    originalPresent: true,
    targetLocal: true,
    targetOptional: false,
    privatePresent: true,
    denied: false,
  },
  {
    originalPresent: true,
    targetLocal: true,
    targetOptional: true,
    privatePresent: true,
    denied: false,
  },
  {
    originalPresent: true,
    targetLocal: false,
    targetOptional: false,
    privatePresent: false,
    denied: false,
  },
  {
    originalPresent: false,
    targetLocal: false,
    targetOptional: false,
    privatePresent: true,
    denied: true,
  },
])("restores optional setting presence across profile changes: %j", async (scenario) => {
  const root = await mkdtemp(path.join(tmpdir(), "nyastra-optional-settings-"));
  roots.push(root);
  fixture.documents = path.join(root, "documents");
  fixture.userData = path.join(root, "data");
  const game = path.join(fixture.documents, "My Games", "Skyrim Special Edition");
  const backup = path.join(fixture.userData, "skyrimse");
  const old = path.join(backup, "profiles", "old");
  const target = path.join(backup, "profiles", "target");
  await Promise.all([game, old, target].map((directory) => mkdir(directory, { recursive: true })));
  const required = ["Skyrim.ini", "SkyrimPrefs.ini"];
  for (const file of required) {
    await writeFile(path.join(game, file), "profile live " + file);
    await writeFile(path.join(game, file + ".base"), "profile base " + file);
    await writeFile(path.join(backup, file), "original global " + file);
    await writeFile(path.join(target, file), "target profile " + file);
  }
  const optional = "SkyrimCustom.ini";
  const privateBytes = "[Display]\niShadowMapResolution=1234\n";
  const globalBytes = "[Display]\niShadowMapResolution=2048\n";
  const targetBytes = "[Display]\niShadowMapResolution=4096\n";
  await writeFile(path.join(old, optional), "obsolete snapshot");
  if (scenario.privatePresent) {
    await Promise.all(
      ["", ".base", ".baked"].map((suffix) =>
        writeFile(path.join(game, optional + suffix), privateBytes),
      ),
    );
  }
  if (scenario.originalPresent) await writeFile(path.join(backup, optional), globalBytes);
  if (scenario.targetOptional) await writeFile(path.join(target, optional), targetBytes);
  const denied = Object.assign(new Error("Optional setting cannot be removed"), { code: "EACCES" });
  if (scenario.denied) fixture.unlinkError = denied;
  const state = {
    settings: {
      profiles: { activeProfileId: "old" },
      gameMode: { discovered: { skyrimse: { store: "steam" } } },
    },
    persistent: {
      profiles: {
        old: { id: "old", gameId: "skyrimse", features: { local_game_settings: true } },
        target: {
          id: "target",
          gameId: "skyrimse",
          features: { local_game_settings: scenario.targetLocal },
        },
      },
      mods: { skyrimse: {} },
    },
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const context = {
    api: {
      store: { getState: () => state, dispatch: vi.fn<(...args: unknown[]) => void>() },
      getState: () => state,
      events: {
        on: (name: string, callback: (...args: unknown[]) => unknown) =>
          handlers.set(name, callback),
      },
      emitAndAwait: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
      showErrorNotification: vi.fn<(...args: unknown[]) => void>(),
    },
    registerProfileFeature: vi.fn<(...args: unknown[]) => void>(),
    registerTest: vi.fn<(...args: unknown[]) => void>(),
    once: (callback: () => void) => callback(),
  };
  expect(init(context as unknown as types.IExtensionContext)).toBe(true);
  const queue: Array<() => PromiseLike<unknown>> = [];
  handlers.get("profile-will-change")("target", (callback: () => PromiseLike<unknown>) =>
    queue.push(callback),
  );
  expect(queue).toHaveLength(1);
  const operation = queue.shift()();
  fixture.work.push(operation);
  await operation;
  await drain();
  expect(queue).toEqual([]);
  expect(fixture.native.size).toBe(0);
  expect(fixture.callbacks.size).toBe(0);
  expect(context.api.showErrorNotification).not.toHaveBeenCalled();
  expect(context.api.emitAndAwait).toHaveBeenCalledTimes(2);
  expect(await readSettingsBytes(path.join(old, optional))).toBe(
    scenario.privatePresent ? privateBytes : null,
  );
  const expected = scenario.denied
    ? privateBytes
    : scenario.targetLocal
      ? scenario.targetOptional
        ? targetBytes
        : null
      : scenario.originalPresent
        ? globalBytes
        : null;
  for (const suffix of ["", ".base", ".baked"]) {
    expect.soft(await readSettingsBytes(path.join(game, optional + suffix))).toBe(expected);
  }
  for (const file of required) {
    expect(await readFile(path.join(game, file), "utf8")).toBe(
      scenario.targetLocal ? "target profile " + file : "original global " + file,
    );
  }
  expect(await readSettingsBytes(path.join(backup, optional))).toBe(
    scenario.originalPresent ? globalBytes : null,
  );
  const expectedError = expect.objectContaining({ error: denied });
  const errors = vi.mocked(util.showError).mock.calls;
  expect(errors).toEqual(
    scenario.denied
      ? [[context.api.store.dispatch, "An error occurred applying game settings", expectedError]]
      : [],
  );
  expect(
    errors.map((call) => Object.getOwnPropertyDescriptor(call[2], "error")?.value === denied),
  ).toEqual(scenario.denied ? [true] : []);
});
