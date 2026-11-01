import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import Zip from "node-7z";
import { expect, test, vi } from "vitest";

import { notificationsReducer } from "../../reducers/notifications";
import { sessionReducer as baseSessionReducer } from "../../reducers/session";
import {
  makeApiHarness,
  makeProfile,
  makeGameStored,
  registerHarnessGame,
  resetHarnessRegistries,
  managerInternals,
} from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import * as activity from "../../util/errorHandling";
import { getGame } from "../gamemode_management/util/getGame";
import hardlinkInit from "../hardlink_activator/index";
import * as profileActions from "../profile_management/actions/profiles";
import { profilesReducer } from "../profile_management/reducers/profiles";
import initMods from "./index";
import InstallManager from "./InstallManager";
import { deploymentReducer } from "./reducers/deployment";
import { sessionReducer } from "./reducers/session";
import { getAllActivators, registerDeploymentMethod } from "./util/deploymentMethods";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// Enabling caches its API, so both cases share the program's registered runtime.
let registered: { h: ReturnType<typeof makeApiHarness>; manager: InstallManager } | undefined;
let retainEnabledWork = <T>(value: PromiseLike<T>): Promise<T> => Promise.resolve(value);

test.each(["before", "during"])(
  "public deploy includes an installation completed %s deployment",
  async (timing) => {
    expect(globalThis.Promise).toBe(Bluebird);
    const overlap = timing === "during";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-install-wait-"));
    const game = "skyrimse";
    const profile = makeProfile({ id: "deploy-wait-owner", gameId: game, modState: {} });
    registerHarnessGame(game);
    const h =
      registered?.h ??
      makeApiHarness(
        {
          profiles: { [profile.id]: profile },
          activeProfileId: profile.id,
          lastActiveProfile: { [game]: profile.id },
          mods: { [game]: {} },
          knownGames: [makeGameStored()],
        },
        [
          { path: ["persistent", "profiles"], reducer: profilesReducer },
          { path: ["persistent", "deployment"], reducer: deploymentReducer },
          { path: ["session", "mods"], reducer: sessionReducer },
          { path: ["session", "notifications"], reducer: notificationsReducer },
          { path: ["session", "base"], reducer: baseSessionReducer },
        ],
      );
    const staging = path.join(root, "staging");
    const output = path.join(root, "game", "Data");
    const archive = path.join(root, "member.zip");
    const payload = "new native installation must be deployed";
    fs.mkdirSync(staging, { recursive: true });
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(root, "selection.txt"), payload);
    await new Zip().add(archive, [path.join(root, "selection.txt")]);
    const archiveBytes = fs.readFileSync(archive);
    h.setState((state) => {
      state.persistent.mods[game] = {};
      state.persistent.profiles[profile.id] = profile;
      state.persistent.deployment.needToDeploy[game] = false;
      state.app = { ...state.app, instanceId: "deploy-install-wait" };
      state.settings.mods.installPath[game] = staging;
      state.settings.mods.activator[game] = "hardlink_activator";
      state.settings.window = { ...state.settings.window, useModernLayout: true };
      state.settings.gameMode.discovered[game] = { path: path.dirname(output) };
      state.settings.automation = {
        ...state.settings.automation,
        deploy: false,
        install: false,
        enable: true,
      };
      state.session.base = {
        ...state.session.base,
        commandLine: {},
        activity: {},
        toolsRunning: {},
        progress: {},
      };
    });
    Object.assign(getGame(game), { queryModPath: () => output, mergeMods: true });
    const work: Promise<unknown>[] = [];
    const outcomes: Array<{ ok: true } | { ok: false; error: unknown }> = [];
    const track = <T>(value: PromiseLike<T>): Promise<T> => {
      const original = Promise.resolve(value);
      work.push(original);
      work.push(
        original.then(
          () => outcomes.push({ ok: true }),
          (error: unknown) => outcomes.push({ ok: false, error }),
        ),
      );
      return original;
    };
    retainEnabledWork = track;
    const drain = async () => {
      let stable = false;
      for (let round = 0; round < 100; round++) {
        const count = work.length;
        await Promise.allSettled(work);
        await new Promise<void>((done) => setImmediate(done));
        if (count === work.length) {
          stable = true;
          break;
        }
      }
      if (!stable) throw new Error("Installation and deployment work did not settle");
      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
      expect(outcomes).toHaveLength(work.length / 2);
    };
    const nativeActivity = activity.withTrackedActivity;
    vi.spyOn(activity, "withTrackedActivity").mockImplementation((...args) =>
      track(nativeActivity(...args)),
    );
    const nativeEnable = profileActions.setModsEnabled;
    vi.spyOn(profileActions, "setModsEnabled").mockImplementation((...args) =>
      Bluebird.resolve(track(nativeEnable(...args))),
    );
    h.api.withPrePost =
      <T, A extends readonly unknown[]>(_name: string, callback: (...args: A) => PromiseLike<T>) =>
      (...args: A) =>
        retainEnabledWork(callback(...args));
    h.api.lookupModMeta = vi.fn<typeof h.api.lookupModMeta>().mockResolvedValue([]);
    h.api.lookupModReference = vi.fn<typeof h.api.lookupModReference>().mockResolvedValue([]);
    h.api.emitAndAwait = (async (event: string, ...args: unknown[]) => {
      await track(h.emitAndAwait(event, ...args));
      return [];
    }) as typeof h.api.emitAndAwait;
    const addedInstaller = vi.spyOn(InstallManager.prototype, "addInstaller");
    const once: Array<() => void> = [];
    // Registration and UI APIs are partial fixture boundaries.
    const context = new Proxy<Partial<IExtensionContext>>(
      { api: h.api, once: (callback) => once.push(callback) },
      {
        get: (target, key): unknown => (key in target ? Reflect.get(target, key) : () => undefined),
      },
    );
    const existingActivators = [...getAllActivators()];
    const gated = deferred();
    const release = deferred();
    const waiting = deferred();
    const callbackDone = deferred();
    const installed = vi.fn<(error: Error | null, id: string) => void>(() =>
      callbackDone.resolve(),
    );
    const deployed = vi.fn<(error: Error | null) => void>();
    hardlinkInit({ api: h.api, registerDeploymentMethod } as IExtensionContext);
    if (registered === undefined) {
      initMods(context as IExtensionContext);
      once.forEach((callback) => callback());
      const manager = addedInstaller.mock.contexts[0];
      if (!(manager instanceof InstallManager)) {
        throw new Error("Installation manager was not registered");
      }
      registered = { h, manager };
    }
    const { manager } = registered;
    const internals = managerInternals(manager);
    const limiters = [internals.mInstallLimit, internals.mDependencyPipelineLimit];
    const capacities = limiters.map((limiter) => limiter.mLimit);
    // Private queue tails and running owners retain otherwise detached work.
    const queues = limiters.map(
      (limiter) => limiter as typeof limiter & { mEndOfQueue: Promise<void> },
    );
    const runningInstalls = manager["mRunningInstalls"];
    for (const limiter of limiters) {
      const nativeDo: typeof limiter.do = limiter.do.bind(limiter);
      vi.spyOn(limiter, "do").mockImplementation(<T>(callback: () => PromiseLike<T>) =>
        track(nativeDo(callback)),
      );
    }
    const nativeSize = internals.setModSize.bind(manager);
    vi.spyOn(internals, "setModSize").mockImplementation((...args) => track(nativeSize(...args)));
    const nativeWait: () => Promise<void> = manager.waitForIdle.bind(manager);
    let waitCount = 0;
    vi.spyOn(manager, "waitForIdle").mockImplementation(() => {
      waitCount++;
      const original = track(nativeWait());
      waiting.resolve();
      return original;
    });
    h.api.onAsync("will-install-mod", async () => {
      gated.resolve();
      await release.promise;
    });
    const deploy = () =>
      track(
        new Promise<void>((resolve, reject) => {
          h.api.events.emit(
            "deploy-mods",
            (error: Error | null) => {
              deployed(error);
              if (error) reject(error);
              else resolve();
            },
            profile.id,
            undefined,
            { manual: true },
          );
        }),
      );
    const assertIdle = () => {
      expect(manager.getActiveInstallations()).toEqual([]);
      expect(manager.getActiveInstallationCount()).toBe(0);
      expect(limiters.map((limiter) => limiter.mLimit)).toEqual(capacities);
      expect(runningInstalls.size).toBe(0);
      expect(internals.mPendingInstalls.size).toBe(0);
      expect(internals.mInstallLimit.mNext).toBeUndefined();
      expect(internals.mDependencyPipelineLimit.mNext).toBeUndefined();
    };
    try {
      h.api.events.emit("start-install", archive, installed);
      for (const original of runningInstalls.values()) void track(original);
      for (const queue of queues) void track(queue.mEndOfQueue);
      await gated.promise;
      expect(manager.getActiveInstallationCount()).toBe(1);
      expect(Object.keys(h.getState().persistent.mods[game])).toEqual([]);
      expect(installed).not.toHaveBeenCalled();
      let deploying: Promise<void> | undefined;
      if (overlap) {
        deploying = deploy();
        await waiting.promise;
      }
      expect(deployed).not.toHaveBeenCalled();
      release.resolve();
      await callbackDone.promise;
      await drain();
      await (deploying ?? deploy());
      for (const queue of queues) void track(queue.mEndOfQueue);
      await drain();
      const mods = Object.values(h.getState().persistent.mods[game]);
      const sourcePath = path.join(staging, "member", "selection.txt");
      const deployedPath = path.join(output, "selection.txt");
      const manifestPath = path.join(output, "vortex.deployment.json");
      const manifest: { files: Array<{ source: string }> } | undefined = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        : undefined;
      const outputBytes = fs.existsSync(deployedPath)
        ? fs.readFileSync(deployedPath, "utf8")
        : null;
      const outputInode = fs.existsSync(deployedPath) ? fs.statSync(deployedPath).ino : null;
      expect(installed).toHaveBeenCalledExactlyOnceWith(null, "member");
      expect(deployed).toHaveBeenCalledExactlyOnceWith(null);
      expect(waitCount).toBe(overlap ? 1 : 0);
      expect(mods.map((mod) => [mod.id, mod.state])).toEqual([["member", "installed"]]);
      expect(h.getState().persistent.profiles[profile.id].modState.member.enabled).toBe(true);
      expect(fs.readFileSync(sourcePath, "utf8")).toBe(payload);
      expect(fs.readFileSync(archive)).toEqual(archiveBytes);
      expect(h.errorNotifications).toEqual([]);
      assertIdle();
      expect.soft(manifest?.files.map((file) => file.source)).toEqual(["member"]);
      expect.soft(fs.existsSync(deployedPath)).toBe(true);
      expect.soft(outputBytes).toBe(payload);
      expect.soft(outputInode).toBe(fs.statSync(sourcePath).ino);
      expect(h.getState().persistent.deployment.needToDeploy[game]).toBe(false);
    } finally {
      release.resolve();
      try {
        for (const original of runningInstalls.values()) void track(original);
        for (const queue of queues) void track(queue.mEndOfQueue);
        await drain();
        assertIdle();
      } finally {
        getAllActivators().splice(0, getAllActivators().length, ...existingActivators);
        vi.restoreAllMocks();
        resetHarnessRegistries();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  },
  20000,
);
