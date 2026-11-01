import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import { expect, test, vi } from "vitest";

import {
  makeApiHarness,
  makeProfile,
  makeGameStored,
  registerHarnessGame,
  resetHarnessRegistries,
  managerInternals,
} from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import Debouncer from "../../util/Debouncer";
import * as activity from "../../util/errorHandling";
import { getGame } from "../gamemode_management/util/getGame";
import hardlinkInit from "../hardlink_activator/index";
import { profilesReducer } from "../profile_management/reducers/profiles";
import initMods from "./index";
import InstallManager from "./InstallManager";
import { getAllActivators, registerDeploymentMethod } from "./util/deploymentMethods";
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("does not reroute a retired explicit profile in the deployment queue", async () => {
  expect(globalThis.Promise).toBe(Bluebird);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queued-profile-"));
  const game = "skyrimse",
    replacementGame = "fallout4";
  registerHarnessGame(game);
  registerHarnessGame(replacementGame);
  const owner = makeProfile({ id: "queued-owner", gameId: game });
  const other = makeProfile({ id: "current-other", gameId: replacementGame });
  const h = makeApiHarness(
    {
      profiles: { [owner.id]: owner, [other.id]: other },
      activeProfileId: other.id,
      knownGames: [makeGameStored(), makeGameStored({ id: replacementGame })],
    },
    [{ path: ["persistent", "profiles"], reducer: profilesReducer }],
  );
  h.setState((s) => {
    s.app = { ...s.app, instanceId: "queue-owner-fixture" };
    for (const g of [game, replacementGame]) {
      s.persistent.mods[g] = {};
      s.settings.mods.installPath[g] = path.join(root, g, "staging");
      s.settings.mods.activator[g] = "hardlink_activator";
      s.settings.gameMode.discovered[g] = { path: path.join(root, g) };
    }
    s.settings.window = { ...s.settings.window, useModernLayout: true };
    s.settings.automation = {
      ...s.settings.automation,
      deploy: false,
      install: false,
      enable: false,
    };
    s.session.base = {
      ...s.session.base,
      commandLine: {},
      activity: {},
      toolsRunning: {},
      progress: {},
    };
  });
  for (const g of [game, replacementGame])
    for (const d of ["staging", "Data"]) fs.mkdirSync(path.join(root, g, d), { recursive: true });
  const selected: string[] = [];
  const deploymentGames: unknown[] = [];
  for (const g of [game, replacementGame])
    Object.assign(getGame(g), {
      queryModPath: () => {
        selected.push(g);
        return path.join(root, g, "Data");
      },
      mergeMods: true,
    });
  const entered = signal(),
    release = signal();
  const operations: PromiseLike<unknown>[] = [];
  const failures: unknown[] = [];
  const track = <T>(p: Promise<T>) => {
    operations.push(p);
    operations.push(
      p.then(
        () => undefined,
        (error) => {
          failures.push(error);
        },
      ),
    );
    return p;
  };
  let deployments = 0;
  vi.spyOn(activity, "withTrackedActivity").mockImplementation((tracer, span, attributes, run) => {
    if (span !== "deployment.deploy") return activityOriginal(tracer, span, attributes, run);
    deployments++;
    deploymentGames.push(attributes["deployment.gameId"]);
    if (deployments === 1) {
      entered.resolve();
      return track(release.promise);
    }
    return track(Promise.resolve());
  });
  const added = vi.spyOn(InstallManager.prototype, "addInstaller");
  const once: Array<() => void> = [];
  const context = new Proxy<Partial<IExtensionContext>>(
    { api: h.api, once: (callback) => once.push(callback) },
    { get: (t, k) => (k in t ? Reflect.get(t, k) : () => undefined) },
  );
  const activators = [...getAllActivators()];
  hardlinkInit({ api: h.api, registerDeploymentMethod } as IExtensionContext);
  initMods(context as IExtensionContext);
  once.forEach((f) => f());
  const manager = added.mock.contexts[0];
  expect(manager).toBeInstanceOf(InstallManager);
  if (!(manager instanceof InstallManager))
    throw new Error("Installation manager was not registered");
  const i = managerInternals(manager);
  const completions: number[] = [];
  const errors: unknown[] = [];
  const queues = new Set<Debouncer>();
  const nativeRun = Debouncer.prototype.runNow;
  vi.spyOn(Debouncer.prototype, "runNow").mockImplementation(function (this: Debouncer, ...args) {
    queues.add(this);
    return nativeRun.apply(this, args);
  });
  let insideQueue = 0;
  const queueRunDescriptor = Object.getOwnPropertyDescriptor(Debouncer.prototype, "run");
  const queueRun = Debouncer.prototype["run"];
  Object.defineProperty(Debouncer.prototype, "run", {
    configurable: true,
    writable: true,
    ...queueRunDescriptor,
    value: function (this: Debouncer, ...args: Parameters<typeof queueRun>) {
      insideQueue++;
      try {
        return queueRun.apply(this, args);
      } finally {
        insideQueue--;
      }
    },
  });
  const nativeFinally = Bluebird.prototype.finally;
  vi.spyOn(Bluebird.prototype, "finally").mockImplementation(function (
    this: Bluebird<unknown>,
    ...args
  ) {
    const result = nativeFinally.apply(this, args);
    if (insideQueue > 0) operations.push(this, result);
    return result;
  });
  const deploy = (slot: number) =>
    track(
      new Promise<void>((resolve, reject) =>
        h.api.events.emit(
          "deploy-mods",
          (e: Error | null) => {
            completions.push(slot);
            if (slot === 1) entered.resolve();
            if (e) {
              errors.push(e);
              entered.resolve();
              reject(e);
              return;
            }
            resolve();
          },
          owner.id,
        ),
      ),
    );
  let first: PromiseLike<unknown> | undefined, second: PromiseLike<unknown> | undefined;
  try {
    first = deploy(1);
    await entered.promise;
    expect(errors).toEqual([]);
    expect(deployments).toBe(1);
    second = deploy(2);
    expect(deployments).toBe(1);
    expect(queues.size).toBe(1);
    for (const q of queues) {
      expect(q["mRunning"]).toBe(true);
      expect(q["mReschedule"]).toBe("immediately");
      expect(q["mArgs"][1]).toBe(owner.id);
      expect(q["mCallbacks"]).toHaveLength(1);
    }
    h.setState((s) => {
      delete s.persistent.profiles[owner.id];
    });
    release.resolve();
    await first;
    await second;
    for (let count = -1; count !== operations.length; ) {
      count = operations.length;
      await Promise.all(operations);
    }
    await Promise.all([
      manager["mInstallLimit"]["mEndOfQueue"],
      manager["mDependencyPipelineLimit"]["mEndOfQueue"],
      ...manager["mRunningInstalls"].values(),
    ]);
    expect(completions).toEqual([1, 2]);
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
    for (const q of queues) {
      expect(q["mRunning"]).toBe(false);
      expect(q["mReschedule"]).toBe("no");
      expect(q["mArgs"]).toBeUndefined();
      expect(q["mCallbacks"]).toEqual([]);
      expect(q["mTimer"]).toBeUndefined();
    }
    expect(manager.getActiveInstallations()).toEqual([]);
    expect(manager.getActiveInstallationCount()).toBe(0);
    expect(i.mPendingInstalls.size).toBe(0);
    expect(manager["mRunningInstalls"].size).toBe(0);
    expect([i.mInstallLimit.mLimit, i.mDependencyPipelineLimit.mLimit]).toEqual([5, 10]);
    expect(i.mInstallLimit.mNext).toBeUndefined();
    expect(i.mDependencyPipelineLimit.mNext).toBeUndefined();
    expect
      .soft(
        deploymentGames,
        "an explicit retired profile must not select the active replacement game",
      )
      .toEqual([game]);
    expect.soft(deployments).toBe(1);
  } finally {
    release.resolve();
    for (let count = -1; count !== operations.length; ) {
      count = operations.length;
      await Promise.all(
        operations.map((p) =>
          Promise.resolve(p).then(
            () => undefined,
            () => undefined,
          ),
        ),
      );
    }
    await Promise.all([
      manager["mInstallLimit"]["mEndOfQueue"],
      manager["mDependencyPipelineLimit"]["mEndOfQueue"],
    ]);
    getAllActivators().splice(0, getAllActivators().length, ...activators);
    if (queueRunDescriptor === undefined) Reflect.deleteProperty(Debouncer.prototype, "run");
    else Object.defineProperty(Debouncer.prototype, "run", queueRunDescriptor);
    vi.restoreAllMocks();
    resetHarnessRegistries();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const activityOriginal = activity.withTrackedActivity;
