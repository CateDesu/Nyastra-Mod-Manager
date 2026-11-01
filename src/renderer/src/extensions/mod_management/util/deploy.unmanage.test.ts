import * as fs from "node:fs";
import path from "node:path";

import { getErrorCode } from "@vortex/shared";
import Bluebird from "bluebird";
import { afterEach, expect, vi, test } from "vitest";

import {
  makeApiHarness,
  makeMod,
  makeProfile,
  makeProfileSwitchHarness,
  managerInternals,
  resetHarnessRegistries,
} from "../../../test-utils/builders";
import { makeDeploymentHarness } from "../../../test-utils/deploymentTest";
import type { IExtensionContext } from "../../../types/IExtensionContext";
import * as paths from "../../../util/getVortexPath";
import { getGame } from "../../gamemode_management/util/getGame";
import profileInit from "../../profile_management";
import { profilesReducer } from "../../profile_management/reducers/profiles";
import { settingsReducer } from "../../profile_management/reducers/settings";
import { onRemoveMod } from "../eventHandlers";
import InstallManager from "../InstallManager";
import { sessionReducer } from "../reducers/session";
import type { IDeployedFile, IDeploymentMethod } from "../types/IDeploymentMethod";
import type { IRemoveModOptions } from "../types/IRemoveModOptions";
import * as activation from "./activationStore";
import BlacklistSet from "./BlacklistSet";
import { getAllActivators, registerDeploymentMethod } from "./deploymentMethods";

function deferred() {
  let resolve: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

afterEach(() => {
  vi.restoreAllMocks();
  getAllActivators().splice(0);
  resetHarnessRegistries();
});

for (const outcome of ["success", "failure"] as const) {
  test(`Stop Managing awaits a busy native purge: ${outcome}`, async () => {
    await import("../index.js");
    expect(global.Promise).toBe(Bluebird);
    expect(Reflect.get(global.Promise, "withResolvers")).toBeUndefined();

    const options = {
      files: { "old.ini": "old bytes" },
      modName: "SomeMod",
      activeProfileId: "p",
      lastActiveProfile: { skyrimse: "p" },
      profiles: { p: makeProfile({ id: "p", gameId: "skyrimse" }) },
      mods: { skyrimse: { SomeMod: makeMod({ id: "SomeMod", installationPath: "SomeMod" }) } },
    };
    const native = makeDeploymentHarness(options);
    try {
      const h = {
        ...native,
        ...makeApiHarness(options, [
          { path: ["persistent", "profiles"], reducer: profilesReducer },
          { path: ["settings", "profiles"], reducer: settingsReducer },
          { path: ["session", "mods"], reducer: sessionReducer },
        ]),
      };
      h.setState((state) => {
        state.app = { ...state.app, instanceId: "unmanage-regression" };
        state.settings.gameMode.discovered.skyrimse = { path: h.gameDir };
        state.settings.mods.installPath.skyrimse = h.stagingDir;
        state.settings.mods.activator.skyrimse = h.method.id;
      });
      getGame("skyrimse").queryModPath = () => h.gameDir;
      registerDeploymentMethod(h.method);
      const profileRoot = path.join(h.stagingDir, "profile-data");
      fs.mkdirSync(path.join(profileRoot, "skyrimse", "profiles", "p"), { recursive: true });
      fs.writeFileSync(
        path.join(profileRoot, "skyrimse", "profiles", "p", "settings.ini"),
        "saved config",
      );
      const originalPath = paths.default;
      vi.spyOn(paths, "default").mockImplementation((id) =>
        id === "userData" ? profileRoot : originalPath(id),
      );
      const modDir = path.join(h.stagingDir, "SomeMod");
      const writeManifest = (files: IDeployedFile[]) =>
        activation.saveActivation(
          "skyrimse",
          "",
          "unmanage-regression",
          h.gameDir,
          h.stagingDir,
          files,
          h.method.id,
        );
      const first = await h.deploy();
      await writeManifest(first);
      const work: PromiseLike<unknown>[] = [];
      const settledErrors: unknown[] = [];
      function track<T>(operation: PromiseLike<T>): PromiseLike<T> {
        work.push(operation);
        return operation;
      }
      async function drain() {
        let count = -1;
        while (count !== work.length) {
          count = work.length;
          await Promise.all(
            work.map((operation) =>
              Promise.resolve(operation).then(
                () => undefined,
                (error: unknown) => {
                  settledErrors.push(error);
                },
              ),
            ),
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      const manager = new InstallManager(h.api, () => h.stagingDir);
      const internal = managerInternals(manager);
      const initialLimits = [
        internal.mInstallLimit.mLimit,
        internal.mDependencyPipelineLimit.mLimit,
      ];
      const markRemoved = vi.spyOn(manager, "markRecentRemoval");
      let context: IExtensionContext;
      const contextHarness = await makeProfileSwitchHarness(
        (registered) => {
          context = registered;
          return false;
        },
        { profiles: [], activeProfileId: undefined, lastActive: {}, waitForStartup: false },
      );
      let unmanage: ((gameId: string) => PromiseLike<void>) | undefined;
      context.api = h.api;
      context.registerAPI = (name, callback) => {
        if (name === "unmanageGame") unmanage = callback;
      };
      profileInit(context);
      if (unmanage === undefined) throw new Error("unmanageGame was not registered");
      h.setNextDialog({ action: "Delete profiles", input: {} });
      h.api.withPrePost =
        <TResult, TArgs extends readonly unknown[]>(
          _event: string,
          callback: (...args: TArgs) => PromiseLike<TResult>,
        ) =>
        (...args: TArgs) => {
          const operation = (async () => {
            await Promise.resolve();
            return callback(...args);
          })();
          track(operation);
          return operation;
        };
      let removalEvents = 0;
      let removalCallbacks = 0;
      let terminalRemovals = 0;
      const originalEmit = h.api.emitAndAwait;
      vi.spyOn(h.api, "emitAndAwait").mockImplementation((event, ...args) => {
        const operation = originalEmit(event, ...args);
        track(operation);
        if (event === "did-remove-mods") {
          track(
            Promise.resolve(operation).then(() => {
              terminalRemovals++;
              return undefined;
            }),
          );
        }
        return operation;
      });
      h.api.events.on(
        "remove-mod",
        (game: string, mod: string, callback: (error: Error) => void, opts: IRemoveModOptions) => {
          removalEvents++;
          onRemoveMod(
            h.api,
            [h.method],
            manager,
            game,
            mod,
            (error) => {
              removalCallbacks++;
              callback(error);
            },
            opts,
          );
        },
      );
      const nativeFinalize: IDeploymentMethod["finalize"] = h.method.finalize.bind(h.method);
      const nativePrepare: IDeploymentMethod["prepare"] = h.method.prepare.bind(h.method);
      const nativePurge: IDeploymentMethod["purge"] = h.method.purge.bind(h.method);
      const finalizeEntered = deferred();
      const releaseFinalize = deferred();
      const purgeRequested = deferred();
      const queuedPurge = deferred();
      const secondPrepare = deferred();
      const manifestWritten = deferred();
      const order: string[] = [];
      let held = true;
      let prepareCalls = 0;
      let purgeCalls = 0;
      let failure: unknown;
      vi.spyOn(h.method, "prepare").mockImplementation((...args) => {
        prepareCalls++;
        if (prepareCalls === 2) secondPrepare.resolve();
        const original = track(nativePrepare(...args));
        const forwarded =
          prepareCalls === 2
            ? Promise.resolve(original).then(() => manifestWritten.promise)
            : original;
        return track(forwarded);
      });
      vi.spyOn(h.method, "finalize").mockImplementation((...args) => {
        if (!held) return track(nativeFinalize(...args));
        held = false;
        finalizeEntered.resolve();
        return track(releaseFinalize.promise.then(() => track(nativeFinalize(...args))));
      });
      vi.spyOn(h.method, "purge").mockImplementation((...args) => {
        purgeCalls++;
        order.push("purge");
        if (outcome === "success") return track(nativePurge(...args));
        const original = track(fs.promises.unlink(h.gameDir));
        return track(
          Promise.resolve(original).catch((error: unknown) => {
            failure = error;
            throw error;
          }),
        );
      });
      const originalLock = activation.withActivationLock;
      let lockRequests = 0;
      vi.spyOn(activation, "withActivationLock").mockImplementation((callback, tryOnly) => {
        lockRequests++;
        const original = originalLock(callback, tryOnly);
        if (lockRequests === 2) {
          purgeRequested.resolve();
          if (!tryOnly) queuedPurge.resolve();
        }
        return original;
      });
      fs.writeFileSync(path.join(modDir, "new.ini"), "new deployment bytes");
      const sourceInode = fs.statSync(path.join(modDir, "new.ini")).ino;
      let deploying: PromiseLike<unknown> = Promise.resolve();

      try {
        deploying = track(
          activation.withActivationLock(async () => {
            await h.method.prepare(h.gameDir, true, first, h.normalize);
            await h.method.activate(
              modDir,
              "SomeMod",
              "",
              new BlacklistSet([], getGame("skyrimse"), h.normalize),
            );
            const files = await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
            await writeManifest(files);
            order.push("deployment saved");
            manifestWritten.resolve();
          }),
        );
        await finalizeEntered.promise;
        const deleting = track(unmanage("skyrimse"));
        await purgeRequested.promise;
        await Promise.race([secondPrepare.promise, queuedPurge.promise, deleting]);
      } finally {
        releaseFinalize.resolve();
        track(
          Promise.resolve(deploying).then(
            () => manifestWritten.resolve(),
            () => manifestWritten.resolve(),
          ),
        );
        await drain();
        await originalLock(() => Promise.resolve());
        await manager.waitForIdle();
        await Promise.all([
          internal.mInstallLimit.do(() => Promise.resolve()),
          internal.mDependencyPipelineLimit.do(() => Promise.resolve()),
        ]);
        await drain();
        await contextHarness.cleanup();
      }
      expect([internal.mInstallLimit.mLimit, internal.mDependencyPipelineLimit.mLimit]).toEqual(
        initialLimits,
      );
      expect([internal.mInstallLimit.mNext, internal.mDependencyPipelineLimit.mNext]).toEqual([
        undefined,
        undefined,
      ]);
      expect(manager.getActiveInstallationCount()).toBe(0);
      expect.soft(purgeCalls).toBe(1);
      expect.soft(order).toEqual(["deployment saved", "purge"]);
      const failed = outcome === "failure";
      const removed = failed ? 0 : 1;
      expect(failure instanceof Error).toBe(failed);
      expect(getErrorCode(failure)).toBe(failed ? "EISDIR" : null);
      expect(settledErrors.length > 0).toBe(failed);
      expect(settledErrors.every((error) => error === failure)).toBe(true);
      expect(h.errorNotifications).toEqual(
        failed
          ? [{ title: "Failed to stop managing game", message: failure, allowReport: true }]
          : [],
      );
      expect(removalEvents).toBe(removed);
      expect(removalCallbacks).toBe(removed);
      expect(terminalRemovals).toBe(removed);
      expect(markRemoved).toHaveBeenCalledTimes(removed);
      expect(Object.keys(h.getState().persistent.profiles)).toEqual(failed ? ["p"] : []);
      expect(Object.keys(h.getState().persistent.mods.skyrimse)).toEqual(failed ? ["SomeMod"] : []);
      const newExists = fs.existsSync(h.inGame("new.ini"));
      expect.soft(newExists).toBe(failed);
      expect(newExists ? fs.statSync(h.inGame("new.ini")).ino : undefined).toBe(
        failed ? sourceInode : undefined,
      );
      expect(newExists ? fs.readFileSync(h.inGame("new.ini"), "utf8") : undefined).toBe(
        failed ? "new deployment bytes" : undefined,
      );
      expect(fs.existsSync(h.inGame("old.ini"))).toBe(failed);
      expect(fs.existsSync(h.inGame("vortex.deployment.json"))).toBe(failed);
      expect(fs.existsSync(modDir)).toBe(failed);
      expect(
        fs.existsSync(path.join(profileRoot, "skyrimse", "profiles", "p", "settings.ini")),
      ).toBe(failed);
      expect(fs.existsSync(path.join(modDir, "old.ini"))).toBe(failed);
    } finally {
      native.cleanup();
    }
  });
}
