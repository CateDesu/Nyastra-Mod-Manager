import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { util } from "@nexusmods/vortex-api";
import PromiseBB from "bluebird";
import { afterEach, expect, it, vi } from "vitest";

import init from "../index";
import type { ISavegame } from "../types/ISavegame";

interface RestoreFixture {
  mods: string;
  work: PromiseLike<unknown>[];
  read?: (directory: string, original: PromiseLike<string[]>) => PromiseLike<string[]>;
}

const fixture = vi.hoisted<RestoreFixture>(() => ({
  mods: "",
  work: [],
  read: undefined,
}));

vi.mock("../views/SavegameList", () => ({ default: () => null }));
vi.mock("@nexusmods/vortex-api", async () => {
  const { createRequire } = await import("node:module");
  const nodePath = await import("node:path");
  const rendererRequire = createRequire(
    nodePath.resolve(import.meta.dirname, "../../../../src/renderer/package.json"),
  );
  const temporal = await vi.importActual<{ install: () => void }>(
    rendererRequire.resolve("temporal-polyfill/shim"),
  );
  temporal.install();
  const native = rendererRequire("fs-extra");
  const { default: Bluebird } = await import("bluebird");
  const { makeOverlayableDictionary } = await vi.importActual<any>(
    "../../../../src/renderer/src/util/util",
  );
  const { default: Debouncer } = await vi.importActual<any>(
    "../../../../src/renderer/src/util/Debouncer",
  );
  return {
    fs: {
      readdirAsync: (directory: string) => {
        const original: PromiseBB<string[]> = Bluebird.resolve(native.readdir(directory));
        const delivered = fixture.read?.(directory, original) ?? original;
        fixture.work.push(original, delivered);
        original.catch(() => undefined);
        Bluebird.resolve(delivered).catch(() => undefined);
        return delivered;
      },
    },
    actions: {},
    log: vi.fn<(...args: unknown[]) => void>(),
    selectors: {
      activeProfile: (state: any) =>
        state.persistent.profiles[state.settings.profiles.activeProfileId],
      activeGameId: (state: any) =>
        state.persistent.profiles[state.settings.profiles.activeProfileId]?.gameId,
    },
    util: {
      makeOverlayableDictionary,
      Debouncer,
      getGame: () => ({ getModPaths: () => ({ "": fixture.mods }) }),
      getSafe: (object: Record<string, unknown>, keys: string[]) => object[keys[0]],
      showActivity: vi.fn<(...args: unknown[]) => void>(),
      showSuccess: vi.fn<(...args: unknown[]) => void>(),
      showError: vi.fn<(...args: unknown[]) => void>(),
    },
  };
});

const roots: string[] = [];
const releases: Array<() => void> = [];

function deferred<T>(): {
  promise: PromiseBB<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new PromiseBB<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function retain<T>(operation: PromiseLike<T>): PromiseLike<T> {
  fixture.work.push(operation);
  PromiseBB.resolve(operation).catch(() => undefined);
  return operation;
}

function observe<T>(invoke: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(PromiseBB.prototype, "then");
  const original = PromiseBB.prototype.then;
  const children: PromiseLike<unknown>[] = [];
  Object.defineProperty(PromiseBB.prototype, "then", {
    ...descriptor,
    value: function (...args: unknown[]) {
      const child = original.apply(this, args);
      children.push(child);
      return child;
    },
  });
  try {
    return invoke();
  } finally {
    Object.defineProperty(PromiseBB.prototype, "then", descriptor);
    children.forEach(retain);
  }
}

async function drain() {
  let count = -1;
  while (count !== fixture.work.length) {
    count = fixture.work.length;
    await PromiseBB.all(
      fixture.work.map((work) =>
        PromiseBB.resolve(work).then(
          () => undefined,
          () => undefined,
        ),
      ),
    );
  }
}

afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await drain();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  fixture.work = [];
  fixture.read = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type Owner = "unchanged" | "same-game" | "cross-game" | "changed-game";
const owners: Owner[] = ["unchanged", "same-game", "cross-game", "changed-game"];
const initialOrder = {
  "a.esp": { name: "A.esp", enabled: false, loadOrder: 1 },
  "b.esp": { name: "B.esp", enabled: true, loadOrder: 0 },
};
const replacementOrder = {
  "b.esp": { name: "B.esp", enabled: true, loadOrder: 4, marker: "replacement B" },
  "a.esp": { name: "A.esp", enabled: false, loadOrder: 9, marker: "replacement A" },
};
const restoredOrder = {
  "a.esp": { name: "A.esp", enabled: true, loadOrder: 0 },
  "b.esp": { name: "B.esp", enabled: false, loadOrder: 1 },
};

async function setup(missing: boolean, readError = false) {
  const { loadOrderReducer } = await vi.importActual<{
    loadOrderReducer: {
      reducers: Record<
        string,
        (state: typeof initialOrder, payload: unknown) => typeof initialOrder
      >;
    };
  }>("../../../../src/renderer/src/extensions/gamebryo_plugin_management/reducers/loadOrder");
  const { handleSetPluginList } = await vi.importActual<{
    handleSetPluginList: (api: unknown, plugins: string[], setEnabled?: boolean) => void;
  }>("../../../../src/renderer/src/extensions/gamebryo_plugin_management/util/onSetPluginList");
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "nyastra-restore-owner-")));
  roots.push(root);
  fixture.mods = path.join(root, "mods");
  if (!readError) {
    await mkdir(fixture.mods);
    if (!missing) await writeFile(path.join(fixture.mods, "A.esp"), "plugin A fixture");
    await writeFile(path.join(fixture.mods, "B.esp"), "plugin B fixture");
  }
  const state = {
    settings: {
      profiles: { activeProfileId: "a", nextProfileId: "a" },
      plugins: { autoEnable: false },
      gameMode: { discovered: { skyrimse: { path: fixture.mods } } },
    },
    persistent: {
      profiles: {
        a: { id: "a", gameId: "skyrimse", features: {} },
        b: { id: "b", gameId: "skyrimse", features: {} },
      },
    },
    loadOrder: structuredClone(initialOrder),
  };
  const delivered = deferred<void>();
  const nativeDone = deferred<void>();
  releases.push(() => delivered.resolve());
  const reads: Array<{ directory: string; error?: NodeJS.ErrnoException }> = [];
  fixture.read = (directory, original) =>
    PromiseBB.resolve(original).then(
      (files) => {
        reads.push({ directory });
        nativeDone.resolve();
        return delivered.promise.then(() => files);
      },
      (error: NodeJS.ErrnoException) => {
        reads.push({ directory, error });
        nativeDone.resolve();
        return delivered.promise.then(() => {
          throw error;
        });
      },
    );
  const dialog = deferred<{ action: string }>();
  const dialogEntered = deferred<void>();
  releases.push(() => dialog.resolve({ action: "Cancel" }));
  const originalDialogThen = dialog.promise.then;
  Object.defineProperty(dialog.promise, "then", {
    configurable: true,
    value: function (...args: unknown[]) {
      delete this.then;
      const child = originalDialogThen.apply(this, args);
      retain(child);
      return child;
    },
  });
  const events: Array<{ name: string; plugins: string[] }> = [];
  const actions: Array<{ type: string; payload: unknown }> = [];
  let afterEmit: (() => void) | undefined;
  const api = {
    store: {
      getState: () => state,
      dispatch: (action: { type: string; payload: unknown }) => {
        actions.push(action);
        const reduce = loadOrderReducer.reducers[action.type];
        if (reduce) state.loadOrder = reduce(state.loadOrder, action.payload);
      },
    },
    getState: () => state,
    translate: (text: string) => text,
    events: {
      emit: (name: string, plugins: string[], setEnabled?: boolean) => {
        events.push({ name, plugins });
        if (name === "set-plugin-list") {
          handleSetPluginList(api, plugins, setEnabled);
          afterEmit?.();
        }
      },
    },
    showDialog: vi.fn<(...args: unknown[]) => PromiseBB<{ action: string }>>(() => {
      fixture.work.push(dialog.promise);
      originalDialogThen.call(dialog.promise, undefined, () => undefined);
      dialogEntered.resolve();
      return dialog.promise;
    }),
    dismissNotification: vi.fn<(...args: unknown[]) => void>(),
    showErrorNotification: vi.fn<(...args: unknown[]) => void>(),
  };
  let props!: () => { onRestorePlugins: (save: ISavegame) => PromiseBB<void> };
  const context = {
    api,
    registerMainPage: (
      _icon: unknown,
      _label: unknown,
      _component: unknown,
      options: { props: typeof props },
    ) => {
      props = options.props;
    },
    registerReducer: vi.fn<(...args: unknown[]) => void>(),
    registerAction: vi.fn<(...args: unknown[]) => void>(),
    registerProfileFeature: vi.fn<(...args: unknown[]) => void>(),
    once: vi.fn<(...args: unknown[]) => void>(),
  };
  expect(init(context as unknown as Parameters<typeof init>[0])).toBe(true);
  const callback = vi.fn<ReturnType<typeof props>["onRestorePlugins"]>(props().onRestorePlugins);
  const save = {
    id: "save-a",
    filePath: "save-a.ess",
    fileSize: 0,
    attributes: { plugins: ["A.esp"] },
  };
  const operation = observe(() => callback(save));
  if (operation !== undefined) retain(operation);
  const switchOwner = (owner: Owner) => {
    if (owner === "unchanged") return;
    if (owner === "changed-game") state.persistent.profiles.a.gameId = "fallout4";
    else {
      state.persistent.profiles.b.gameId = owner === "cross-game" ? "fallout4" : "skyrimse";
      state.settings.profiles.activeProfileId = "b";
      state.settings.profiles.nextProfileId = "b";
    }
    state.loadOrder = structuredClone(replacementOrder);
  };
  const finish = async () => {
    await operation;
    await drain();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(reads).toHaveLength(1);
    expect(reads[0].directory).toBe(fixture.mods);
    expect(api.showErrorNotification).not.toHaveBeenCalled();
    expect
      .soft(operation, "public callback must retain the complete operation")
      .toBeInstanceOf(PromiseBB);
    expect.soft(operation?.isFulfilled()).toBe(true);
    expect(util.showActivity).toHaveBeenCalledTimes(1);
  };
  return {
    state,
    api,
    events,
    actions,
    operation,
    reads,
    finish,
    switchOwner,
    dialog,
    nativeDone: nativeDone.promise,
    dialogEntered: dialogEntered.promise,
    releaseRead: () => delivered.resolve(),
    invoke: (plugins: string[]) => {
      const next = observe(() => callback({ ...save, id: "save-b", attributes: { plugins } }));
      retain(next);
      return next;
    },
    callbackCount: () => callback.mock.calls.length,
    switchAfterEmit: () => {
      afterEmit = () => switchOwner("same-game");
    },
  };
}

it.each(
  owners.flatMap((owner) =>
    ["available", "missing", "error"].map((outcome) => ({ owner, outcome })),
  ),
)("retains native restore ownership for $outcome with $owner owner", async ({ owner, outcome }) => {
  const test = await setup(outcome === "missing", outcome === "error");
  try {
    await test.nativeDone;
    expect(test.events).toEqual([]);
    expect(test.api.showDialog).not.toHaveBeenCalled();
    expect
      .soft(test.operation?.isPending(), "callback must await original native delivery")
      .toBe(true);
    test.switchOwner(owner);
  } finally {
    test.releaseRead();
    test.dialog.resolve({ action: "Continue" });
  }
  await test.finish();
  const current = owner === "unchanged";
  const restored = current && outcome !== "error";
  expect(test.state.loadOrder).toEqual(
    current ? (restored ? restoredOrder : initialOrder) : replacementOrder,
  );
  expect(test.events).toEqual(restored ? [{ name: "set-plugin-list", plugins: ["A.esp"] }] : []);
  expect(test.actions).toHaveLength(restored ? 1 : 0);
  expect(test.api.showDialog).toHaveBeenCalledTimes(current && outcome === "missing" ? 1 : 0);
  expect(util.showSuccess).toHaveBeenCalledTimes(restored ? 1 : 0);
  expect(util.showError).toHaveBeenCalledTimes(current && outcome === "error" ? 1 : 0);
  expect(test.api.dismissNotification).not.toHaveBeenCalled();
  expect(test.reads[0].error?.code).toBe(outcome === "error" ? "ENOENT" : undefined);
});

it.each(
  owners.flatMap((owner) =>
    ["Continue", "Cancel", "error"].map((decision) => ({ owner, decision })),
  ),
)(
  "retains missing-plugin dialog ownership for $decision with $owner owner",
  async ({ owner, decision }) => {
    const test = await setup(true);
    try {
      await test.nativeDone;
      test.releaseRead();
      await test.dialogEntered;
      expect(test.events).toEqual([]);
      expect(test.api.showDialog).toHaveBeenCalledTimes(1);
      expect
        .soft(test.operation?.isPending(), "callback must await missing-plugin dialog")
        .toBe(true);
      test.switchOwner(owner);
    } finally {
      test.releaseRead();
      if (decision === "error") test.dialog.reject(new Error("dialog delivery failed"));
      else test.dialog.resolve({ action: decision });
    }
    await test.finish();
    const current = owner === "unchanged";
    const restored = current && decision === "Continue";
    expect(test.state.loadOrder).toEqual(
      current ? (restored ? restoredOrder : initialOrder) : replacementOrder,
    );
    expect(test.events).toEqual(restored ? [{ name: "set-plugin-list", plugins: ["A.esp"] }] : []);
    expect(test.actions).toHaveLength(restored ? 1 : 0);
    expect(util.showSuccess).toHaveBeenCalledTimes(restored ? 1 : 0);
    expect(util.showError).toHaveBeenCalledTimes(current && decision === "error" ? 1 : 0);
    expect(test.api.dismissNotification).toHaveBeenCalledTimes(
      current && decision === "Cancel" ? 1 : 0,
    );
    expect(test.api.showDialog).toHaveBeenCalledWith(
      "question",
      "Restore plugins",
      expect.objectContaining({ options: { translated: true } }),
      [{ label: "Cancel" }, { label: "Continue" }],
    );
  },
);

it.each([false, true])(
  "revalidates success after synchronous plugin listeners with missing=%s",
  async (missing) => {
    const test = await setup(missing);
    test.switchAfterEmit();
    await test.nativeDone;
    test.releaseRead();
    test.dialog.resolve({ action: "Continue" });
    await test.finish();
    expect(test.events).toEqual([{ name: "set-plugin-list", plugins: ["A.esp"] }]);
    expect(test.actions).toHaveLength(1);
    expect(test.state.loadOrder).toEqual(replacementOrder);
    expect(util.showSuccess).not.toHaveBeenCalled();
    expect(util.showError).not.toHaveBeenCalled();
  },
);

it.each(
  ["available", "missing", "error"].flatMap((outcome) =>
    ["request", "reverse"].map((order) => ({ outcome, order })),
  ),
)(
  "keeps the newest same-profile restore for $outcome in $order order",
  async ({ outcome, order }) => {
    const first = await setup(outcome === "missing", outcome === "error");
    const secondReady = deferred<void>();
    const secondRelease = deferred<void>();
    releases.push(() => secondRelease.resolve());
    let second: PromiseLike<void> | undefined;
    try {
      await first.nativeDone;
      if (outcome === "error") {
        await mkdir(fixture.mods);
        await writeFile(path.join(fixture.mods, "B.esp"), "plugin B fixture");
      }
      fixture.read = (directory, original) =>
        PromiseBB.resolve(original).then((files) => {
          expect(directory).toBe(fixture.mods);
          secondReady.resolve();
          return secondRelease.promise.then(() => files);
        });
      second = first.invoke(["B.esp"]);
      await secondReady.promise;
      first.dialog.resolve({ action: "Continue" });
      expect(first.events).toEqual([]);
      let interimEvents: typeof first.events;
      if (order === "request") {
        first.releaseRead();
        await first.operation;
        interimEvents = first.events.slice();
        secondRelease.resolve();
        await second;
      } else {
        secondRelease.resolve();
        await second;
        interimEvents = first.events.slice();
        first.releaseRead();
        await first.operation;
      }
      await drain();
      expect(interimEvents, "Only the newest request may apply at the delivery boundary").toEqual(
        order === "request" ? [] : [{ name: "set-plugin-list", plugins: ["B.esp"] }],
      );
      expect(first.callbackCount()).toBe(2);
      expect(first.events, "The latest request owns the plugin reducer").toEqual([
        { name: "set-plugin-list", plugins: ["B.esp"] },
      ]);
      expect(first.actions).toHaveLength(1);
      expect(
        Object.values(first.state.loadOrder)
          .filter((plugin) => plugin.enabled)
          .map((plugin) => plugin.name),
      ).toEqual(["B.esp"]);
      expect(first.api.showDialog).not.toHaveBeenCalled();
      expect(first.api.dismissNotification).not.toHaveBeenCalled();
      expect(util.showSuccess).toHaveBeenCalledTimes(1);
      expect(util.showError).not.toHaveBeenCalled();
      expect(first.api.showErrorNotification).not.toHaveBeenCalled();
    } finally {
      first.releaseRead();
      secondRelease.resolve();
      first.dialog.resolve({ action: "Cancel" });
      await first.operation;
      await second;
      await drain();
    }
  },
);

it.each(["Continue", "Cancel", "error"])(
  "ignores superseded same-profile restore dialog completion: %s",
  async (decision) => {
    const first = await setup(true);
    let second: PromiseLike<void> | undefined;
    try {
      await first.nativeDone;
      first.releaseRead();
      await first.dialogEntered;
      expect(first.api.showDialog).toHaveBeenCalledTimes(1);
      fixture.read = undefined;
      second = first.invoke(["B.esp"]);
      await second;
      expect(first.events).toEqual([{ name: "set-plugin-list", plugins: ["B.esp"] }]);
      if (decision === "error") first.dialog.reject(new Error("obsolete dialog failure"));
      else first.dialog.resolve({ action: decision });
      await first.operation;
      await drain();
      expect(first.callbackCount()).toBe(2);
      expect(first.events, "An obsolete dialog must not replace the latest selection").toEqual([
        { name: "set-plugin-list", plugins: ["B.esp"] },
      ]);
      expect(first.actions).toHaveLength(1);
      expect(
        Object.values(first.state.loadOrder)
          .filter((plugin) => plugin.enabled)
          .map((plugin) => plugin.name),
      ).toEqual(["B.esp"]);
      expect(first.api.dismissNotification).not.toHaveBeenCalled();
      expect(util.showSuccess).toHaveBeenCalledTimes(1);
      expect(util.showError).not.toHaveBeenCalled();
      expect(first.api.showErrorNotification).not.toHaveBeenCalled();
    } finally {
      first.releaseRead();
      first.dialog.resolve({ action: "Cancel" });
      await first.operation;
      await second;
      await drain();
    }
  },
);
