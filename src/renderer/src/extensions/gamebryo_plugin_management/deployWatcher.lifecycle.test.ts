import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import type { ILookupResult } from "modmeta-db";
import { expect, test, vi, onTestFinished } from "vitest";

import { sessionReducer } from "../../reducers/session";
import {
  makeApiHarness,
  makeMod,
  makeProfile,
  makeGameStored,
  registerHarnessGame,
  resetHarnessRegistries,
  managerInternals,
} from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import { UserCanceled } from "../../util/CustomErrors";
import type DebouncerType from "../../util/Debouncer";
import Debouncer from "../../util/Debouncer";
import * as snapshots from "../analytics/utils/modListSnapshot";
import { getGame } from "../gamemode_management/util/getGame";
import hardlinkInit from "../hardlink_activator/index";
import type initModsType from "../mod_management/index";
import InstallManager from "../mod_management/InstallManager";
import { deploymentReducer } from "../mod_management/reducers/deployment";
import { sessionReducer as modsSessionReducer } from "../mod_management/reducers/session";
import {
  getAllActivators,
  registerDeploymentMethod,
} from "../mod_management/util/deploymentMethods";
import * as changes from "../mod_management/util/externalChanges";
import { setPluginOrder } from "./actions/loadOrder";
import { startDeployWatcher } from "./deployWatcher";
import { REDUCER_BINDINGS } from "./reducers/bindings";

const NativePromise = (async () => undefined)().constructor as PromiseConstructor;
const initiallySettled = () => NativePromise.resolve();

for (const mode of ["success", "cancel", "failure"] as const) {
  test(`public deployment releases the plugin watcher after ${mode}`, async () => {
    // Isolate the deployment module's installer manager while keeping shared runtime modules.
    const { default: initMods } = await vi.importActual<{ default: typeof initModsType }>(
      `../mod_management/index?watcher=${mode}`,
    );
    expect(globalThis.Promise).toBe(Bluebird);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `deployment-${mode}-`)));
    const activators = [...getAllActivators()];
    let settle: () => Promise<void> = initiallySettled;
    onTestFinished(async () => {
      try {
        await settle();
      } finally {
        getAllActivators().splice(0, getAllActivators().length, ...activators);
        vi.restoreAllMocks();
        resetHarnessRegistries();
        fs.rmSync(root, { recursive: true, force: true });
        expect(fs.existsSync(root)).toBe(false);
      }
    });
    const game = "skyrimse";
    registerHarnessGame(game);
    const profile = makeProfile({
      id: `watcher-${mode}`,
      gameId: game,
      modState: { fixture: { enabled: true, enabledTime: 0 } },
    });
    const h = makeApiHarness(
      {
        profiles: { [profile.id]: profile },
        activeProfileId: profile.id,
        knownGames: [makeGameStored()],
      },
      [
        ...REDUCER_BINDINGS,
        { path: ["session", "base"], reducer: sessionReducer },
        { path: ["session", "mods"], reducer: modsSessionReducer },
        { path: ["persistent", "deployment"], reducer: deploymentReducer },
      ],
    );
    h.setState((s) => {
      s.app = { ...s.app, instanceId: "watcher-fixture" };
      s.persistent.mods[game] = {
        fixture: makeMod({ id: "fixture", installationPath: "fixture" }),
      };
      s.settings.mods.installPath[game] = path.join(root, "staging");
      s.settings.mods.activator[game] = "hardlink_activator";
      s.settings.gameMode.discovered[game] = { path: root };
      s.settings.window = { ...s.settings.window, useModernLayout: true };
      s.settings.automation = {
        ...s.settings.automation,
        deploy: false,
        install: false,
        enable: false,
      };
      s.session.base = {
        ...s.session.base,
        activity: {},
        toolsRunning: {},
        commandLine: {},
        progress: {},
      };
    });
    for (const d of ["Data", "staging"]) fs.mkdirSync(path.join(root, d));
    Object.assign(getGame(game), { queryModPath: () => path.join(root, "Data"), mergeMods: true });
    fs.mkdirSync(path.join(root, "staging", "fixture"));
    const source = path.join(root, "staging", "fixture", "fixture.txt");
    const target = path.join(root, "Data", "fixture.txt");
    fs.writeFileSync(source, "deployment fixture bytes");
    const operations: PromiseLike<unknown>[] = [];
    const track = <T>(p: PromiseLike<T>): PromiseLike<T> => {
      operations.push(p);
      void NativePromise.resolve(p).catch(() => undefined);
      return p;
    };
    h.api.lookupModMeta = () => {
      const pending = Bluebird.resolve<ILookupResult[]>([]);
      track(pending);
      return pending;
    };
    h.api.emitAndAwait = ((event: string, ...args: unknown[]) => {
      const running = h.api.events.listeners(event).map((listener) => {
        try {
          return NativePromise.resolve(
            track(NativePromise.resolve(Reflect.apply(listener, undefined, args))),
          );
        } catch (error) {
          return NativePromise.reject(error);
        }
      });
      return track(NativePromise.all(running).then(() => []));
    }) as typeof h.api.emitAndAwait;
    const snapshotResults: PromiseLike<unknown>[] = [];
    const emitSnapshot = snapshots.emitModListSnapshot;
    vi.spyOn(snapshots, "emitModListSnapshot").mockImplementation((...args) => {
      const pending = emitSnapshot(...args);
      snapshotResults.push(pending);
      track(pending);
      return pending;
    });
    const once: Array<() => void> = [];
    const context = new Proxy(
      { api: h.api, once: (f: () => void) => once.push(f) },
      { get: (obj, key) => (key in obj ? Reflect.get(obj, key) : () => undefined) },
    ) as unknown as IExtensionContext;
    const added = vi.spyOn(InstallManager.prototype, "addInstaller");
    hardlinkInit({ api: h.api, registerDeploymentMethod } as IExtensionContext);
    initMods(context);
    once.forEach((f) => f());
    const manager = added.mock.contexts[0];
    expect(manager).toBeInstanceOf(InstallManager);
    if (!(manager instanceof InstallManager)) throw new Error("Manager not registered");
    const i = managerInternals(manager);
    const trigger = vi.fn<(check: string, delay: number) => void>();
    const postDeployObservations: Array<{ deploying: boolean; checks: unknown[][] }> = [];
    const onDidDeploy = vi.fn<() => Promise<void>>(() => {
      postDeployObservations.push({
        deploying: watcher.isDeploying(),
        checks: trigger.mock.calls.map((call) => [...call]),
      });
      return NativePromise.resolve();
    });
    h.api.events.on("trigger-test-run", trigger);
    const watcher = startDeployWatcher(h.api, onDidDeploy);
    const order: string[] = [];
    h.api.onAsync("will-deploy", () => {
      order.push("will-deploy");
      h.api.store.dispatch(setPluginOrder(["during.esp"], true));
      return NativePromise.resolve();
    });
    h.api.onAsync("did-deploy", () => {
      order.push("did-deploy");
      return NativePromise.resolve();
    });
    // Fail only the external-change boundary. The public queue and deployment stay real.
    const failure =
      mode === "cancel"
        ? new UserCanceled()
        : Object.assign(new Error("fixture disk failure"), { code: "ENOSPC" });
    if (mode !== "success")
      vi.spyOn(changes, "dealWithExternalChanges").mockImplementation(() => {
        order.push("abort");
        return NativePromise.reject(failure);
      });
    let inQueue = false;
    const queues = new Set<DebouncerType>();
    const runNow = Debouncer.prototype.runNow;
    vi.spyOn(Debouncer.prototype, "runNow").mockImplementation(function (
      this: DebouncerType,
      ...args
    ) {
      queues.add(this);
      inQueue = true;
      try {
        runNow.apply(this, args);
      } finally {
        inQueue = false;
      }
    });
    const finallyMethod = Bluebird.prototype.finally;
    vi.spyOn(Bluebird.prototype, "finally").mockImplementation(function (
      this: Bluebird<unknown>,
      ...args
    ) {
      const result = finallyMethod.apply(this, args);
      if (inQueue) {
        track(this);
        track(result);
      }
      return result;
    });
    settle = async () => {
      for (let count = -1; count !== operations.length; ) {
        count = operations.length;
        await NativePromise.all(
          operations.map((p) =>
            NativePromise.resolve(p).then(
              () => undefined,
              () => undefined,
            ),
          ),
        );
      }
      await NativePromise.allSettled([
        manager["mInstallLimit"]["mEndOfQueue"],
        manager["mDependencyPipelineLimit"]["mEndOfQueue"],
        ...manager["mRunningInstalls"].values(),
      ]);
    };
    const completions: unknown[] = [];
    await track(
      new NativePromise<void>((resolve, reject) =>
        h.api.events.emit(
          "deploy-mods",
          (error: unknown) => {
            completions.push(error);
            if (error === null) {
              resolve();
            } else {
              reject(error);
            }
          },
          profile.id,
          undefined,
          { manual: true },
        ),
      ),
    );
    await settle();
    expect(order).toEqual(
      mode === "success" ? ["will-deploy", "did-deploy"] : ["will-deploy", "abort"],
    );
    expect(completions).toEqual([null]);
    expect(h.getState().session.base.activity.mods).toEqual([]);
    expect(h.errorNotifications).toHaveLength(mode === "failure" ? 1 : 0);
    expect(onDidDeploy).toHaveBeenCalledTimes(mode === "success" ? 1 : 0);
    expect(postDeployObservations).toEqual(
      mode === "success" ? [{ deploying: false, checks: [["plugins-changed", 500]] }] : [],
    );
    expect(await NativePromise.all(snapshotResults)).toEqual(mode === "success" ? [undefined] : []);
    expect(queues.size).toBe(1);
    for (const q of queues) {
      expect(q["mRunning"]).toBe(false);
      expect(q["mReschedule"]).toBe("no");
      expect(q["mCallbacks"]).toEqual([]);
      expect(q["mAddCallbacks"]).toEqual([]);
      expect(q["mArgs"]).toBeUndefined();
      expect(q["mTimer"]).toBeUndefined();
    }
    expect(manager.getActiveInstallationCount()).toBe(0);
    expect(i.mPendingInstalls.size).toBe(0);
    expect(manager["mRunningInstalls"].size).toBe(0);
    expect([i.mInstallLimit.mLimit, i.mDependencyPipelineLimit.mLimit]).toEqual([5, 10]);
    expect(i.mInstallLimit.mNext).toBeUndefined();
    expect(i.mDependencyPipelineLimit.mNext).toBeUndefined();
    expect
      .soft(watcher.isDeploying(), "A settled deployment must release the plugin watcher")
      .toBe(false);
    expect
      .soft(trigger.mock.calls, "Queued plugin changes must drain after every terminal path")
      .toEqual([["plugins-changed", 500]]);
    expect(fs.readFileSync(source, "utf8")).toBe("deployment fixture bytes");
    expect(fs.existsSync(target)).toBe(mode === "success");
    const sourceStat = fs.statSync(source);
    const deployed = fs.existsSync(target)
      ? {
          bytes: fs.readFileSync(target, "utf8"),
          dev: fs.statSync(target).dev,
          ino: fs.statSync(target).ino,
        }
      : undefined;
    expect(deployed).toEqual(
      mode === "success"
        ? { bytes: "deployment fixture bytes", dev: sourceStat.dev, ino: sourceStat.ino }
        : undefined,
    );
    trigger.mockClear();
    h.api.store.dispatch(setPluginOrder(["after.esp", "during.esp"], true));
    expect(h.getState()).toHaveProperty("loadOrder", {
      "after.esp": { name: "after.esp", enabled: true, loadOrder: 0 },
      "during.esp": { name: "during.esp", enabled: true, loadOrder: 1 },
    });
    expect
      .soft(watcher.isDeploying(), "A settled deployment must release the plugin watcher")
      .toBe(false);
    expect
      .soft(trigger.mock.calls, "A later plugin change must schedule its health check")
      .toEqual([["plugins-changed", 500]]);
  });
}
