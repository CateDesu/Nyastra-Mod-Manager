import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import Zip from "node-7z";
import { expect, vi, afterEach } from "vitest";

import {
  makeApiHarness,
  makeProfile,
  makeMod,
  makeRule,
  makeDownload,
  makeGameStored,
  makeLoadOrder,
  registerHarnessGame,
  managerInternals,
} from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import type { IExtensionContext } from "../../types/IExtensionContext";
import * as fsUtil from "../../util/fs";
import { downloadPathForGame } from "../../util/selectors";
import { setFBLoadOrder } from "../file_based_loadorder/actions/loadOrder";
import initLoadOrder from "../file_based_loadorder/index";
import { REDUCER_BINDINGS } from "../file_based_loadorder/reducers/bindings";
import { loadOrderForProfile } from "../file_based_loadorder/selectors";
import type { ILoadOrderGameInfo } from "../file_based_loadorder/types/types";
import InstallManager from "../mod_management/InstallManager";
import { profilesReducer } from "../profile_management/reducers/profiles";
import { addExtension } from "./util/extension";
import InstallDriver from "./util/InstallDriver";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => {
  vi.restoreAllMocks();
});

for (const scenario of [
  "active",
  "manual",
  "manual-recommended",
  "manual-switched",
  "unrelated",
  "same-collection-other-owner",
  "cancel-deploy",
  "live-deploy",
  "cancel-deferred",
  "live-deferred",
  "cancel-plugin-scan",
  "live-plugin-scan",
] as const) {
  test(`public dependency completion keeps its attempt owner: ${scenario}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "collection-owner-"));
    const staging = path.join(root, "staging");
    const game = "skyrimse";
    registerHarnessGame(game);
    const a = makeProfile({ id: "post-a", gameId: game });
    const b = makeProfile({ id: "post-b", gameId: game });
    const rule = makeRule({
      type: scenario === "manual-recommended" ? "recommends" : "requires",
      reference: { tag: "post-member", gameId: game },
    });
    const collection = makeMod({
      id: "collection",
      type: "collection",
      installationPath: "collection",
      archiveId: "archive",
      rules: [rule],
    });
    const member = makeMod({
      id: "member",
      installationPath: "member",
      archiveId: "member-archive",
      attributes: { referenceTag: "post-member" },
    });
    const h = makeApiHarness(
      {
        knownGames: [makeGameStored()],
        profiles: { [a.id]: a, [b.id]: b },
        activeProfileId: a.id,
        lastActiveProfile: { [game]: a.id },
        installPath: { [game]: staging },
        mods: { [game]: { collection, member } },
        downloads: {
          archive: makeDownload({ id: "archive", state: "finished", game: [game], modInfo: {} }),
        },
      },
      [...REDUCER_BINDINGS, { path: ["persistent", "profiles"], reducer: profilesReducer }],
    );
    h.setState((s) => {
      Object.assign(s, { userlist: { plugins: [], groups: [] } });
      Object.assign(s.session, { notifications: { notifications: [] } });
      s.settings.downloads.path = path.join(root, "downloads");
      s.settings.mods.activator[game] = "empty";
      s.settings.automation = {
        deploy: false,
        install: false,
        enable: true,
        start: false,
        minimized: false,
      };
    });
    const oldA = makeLoadOrder("old-a.pak");
    const oldB = makeLoadOrder("keep-b.pak");
    const incoming = makeLoadOrder("collection-first.pak", "collection-second.pak");
    h.api.store.dispatch(setFBLoadOrder(a.id, oldA));
    h.api.store.dispatch(setFBLoadOrder(b.id, oldB));
    await fs.mkdir(path.join(staging, "collection"), { recursive: true });
    await fs.mkdir(path.join(staging, "member"), { recursive: true });
    await fs.writeFile(path.join(staging, "member", "payload.txt"), "existing installed member");
    await fs.writeFile(path.join(staging, "member", "Member.esp"), "member plugin");
    const dlDirectory = downloadPathForGame(h.getState(), game);
    await fs.mkdir(dlDirectory, { recursive: true });
    const archive = path.join(dlDirectory, "member.zip");
    await new Zip().add(archive, [path.join(staging, "member", "payload.txt")]);
    const archiveSize = (await fs.stat(archive)).size;
    h.setState((s) => {
      s.persistent.downloads.files["member-archive"] = makeDownload({
        id: "member-archive",
        state: "finished",
        game: [game],
        localPath: "member.zip",
        size: archiveSize,
        modInfo: { referenceTag: "post-member" },
      });
    });
    await fs.writeFile(
      path.join(staging, "collection", "collection.json"),
      JSON.stringify({
        info: {
          author: "Fixture",
          authorUrl: "",
          name: "Fixture",
          description: "",
          installInstructions: "",
          domainName: "skyrimspecialedition",
          gameVersions: [],
        },
        mods: [],
        modRules: [],
        loadOrder: incoming,
        pluginRules: { plugins: [], groups: [] },
      }),
    );
    const unrelated = makeMod({
      id: "unrelated",
      type: "collection",
      archiveId: "archive",
      rules: [],
    });
    h.setState((s) => {
      s.persistent.mods[game][unrelated.id] = unrelated;
    });
    const work: Promise<unknown>[] = [];
    const track = <T>(p: PromiseLike<T>): Promise<T> => {
      const actual = Promise.resolve(p);
      work.push(actual);
      void actual.catch(() => undefined);
      return actual;
    };

    const drain = async () => {
      let n = -1;
      let rounds = 0;
      let results: Array<{ status: "fulfilled" } | { status: "rejected"; reason: unknown }> = [];
      while (n !== work.length) {
        expect(rounds++).toBeLessThan(100);
        n = work.length;
        results = await Promise.all(
          [
            ...work,
            manager["mInstallLimit"]["mEndOfQueue"],
            manager["mDependencyPipelineLimit"]["mEndOfQueue"],
            ...manager["mRunningInstalls"].values(),
          ].map((promise) =>
            promise.then(
              () => ({ status: "fulfilled" as const }),
              (reason: unknown) => ({ status: "rejected" as const, reason }),
            ),
          ),
        );
        await tick();
      }
      expect(results.filter((v) => v.status === "rejected")).toEqual([]);
    };
    let enabledFeature = true;
    let addLoadOrder: (info: ILoadOrderGameInfo) => void;
    const context = new Proxy(
      {
        api: h.api,
        registerAPI: (name, fn) => {
          if (name === "addLoadOrderPage") addLoadOrder = fn;
        },
        optional: {
          registerCollectionFeature: (id, generate, parse, clone, title, condition) =>
            addExtension({
              id: id + root,
              generate,
              parse,
              clone,
              title,
              condition: (s, g) =>
                enabledFeature && s.settings.mods.installPath[g] === staging && condition(s, g),
            }),
        },
      },
      { get: (target, name) => (name in target ? target[name] : () => undefined) },
    );
    initLoadOrder(context as unknown as IExtensionContext);
    addLoadOrder({
      gameId: game,
      serializeLoadOrder: async () => undefined,
      deserializeLoadOrder: async () => [],
      validate: async () => undefined,
    });
    const on = h.api.events.on.bind(h.api.events);
    vi.spyOn(h.api.events, "on").mockImplementation((event, listener) =>
      on(event, (...args) => {
        const result = (listener as (...args: unknown[]) => Promise<unknown> | undefined)(...args);
        return result?.then ? track(result) : result;
      }),
    );
    const driver = new InstallDriver(h.api);
    const manager = new InstallManager(h.api, () => staging);
    const cancelRequests: Promise<unknown>[] = [];
    h.api.emitAndAwait = ((event: string, ...args: unknown[]) => {
      const result = track(h.emitAndAwait(event, ...args).then(() => []));
      if (event === "cancel-dependency-install") cancelRequests.push(result);
      return result;
    }) as typeof h.api.emitAndAwait;
    const cancelDriver = async () => {
      driver.cancel();
      await Promise.all(cancelRequests);
    };
    const i = managerInternals(manager);
    for (const limiter of [i.mInstallLimit, i.mDependencyPipelineLimit]) {
      const original = limiter.do.bind(limiter);
      vi.spyOn(limiter, "do").mockImplementation((fn) => track(original(fn)));
    }
    const entered = deferred();
    const release = deferred();
    h.api.lookupModReference = () => {
      entered.resolve();
      return Bluebird.resolve(release.promise).then(() => []);
    };
    h.api.lookupModMeta = () => Bluebird.resolve([]);
    h.api.withPrePost =
      (_name, cb) =>
      (...args) => {
        const promise = cb(...args);
        track(promise);
        return promise;
      };
    const deployments: string[] = [];
    const deploying = deferred();
    let finishDeploy: (() => void) | undefined;
    const deployCallback = vi.fn();
    let deployFinished = false;
    h.api.events.on("deploy-mods", (cb, profileId) => {
      deployments.push(profileId);
      finishDeploy = () => {
        if (deployFinished) return;
        deployFinished = true;
        deployCallback();
        cb(null);
      };
      if (scenario.endsWith("deploy")) deploying.resolve();
      else finishDeploy();
    });
    const completions: unknown[][] = [];
    h.api.events.on("did-install-dependencies", (...args) => completions.push(args));
    const completed = vi.fn();
    h.api.events.on("collection-postprocess-complete", completed);
    const scanEntered = deferred();
    const releaseScan = deferred();
    let scans = 0;
    const readdir = fsUtil.readdirAsync;
    vi.spyOn(fsUtil, "readdirAsync").mockImplementation((directory) =>
      readdir(directory).then((files) => {
        if (scenario.endsWith("plugin-scan") && directory === path.join(staging, "member")) {
          scans++;
          scanEntered.resolve();
          return releaseScan.promise.then(() => files);
        }
        return files;
      }),
    );
    let original: Promise<void> | undefined;
    try {
      if (
        [
          "active",
          "cancel-deploy",
          "live-deploy",
          "cancel-deferred",
          "live-deferred",
          "cancel-plugin-scan",
          "live-plugin-scan",
        ].includes(scenario)
      ) {
        await driver.start(a, collection);
      } else if (scenario === "unrelated") {
        await driver.start(b, unrelated);
      } else if (scenario === "same-collection-other-owner") {
        await driver.start(b, collection);
      }
      const sessionBefore = driver.currentSessionId;
      original = h.emitAndAwait(
        "install-from-dependencies",
        collection.id,
        [rule],
        scenario === "manual-recommended",
        a.id,
      );
      await entered.promise;
      const switched = scenario === "manual-switched" || scenario.endsWith("deferred");
      if (switched)
        h.setState((s) => {
          s.settings.profiles.activeProfileId = b.id;
          s.settings.profiles.lastActiveProfile[game] = b.id;
        });
      release.resolve();
      await original;
      const manual = makeLoadOrder("later-manual-order.pak");
      if (scenario.endsWith("deploy")) {
        await deploying.promise;
        if (scenario === "cancel-deploy") {
          await cancelDriver();
          h.api.store.dispatch(setFBLoadOrder(a.id, manual));
        }
        finishDeploy?.();
      }
      if (scenario.endsWith("plugin-scan")) {
        await scanEntered.promise;
        if (scenario === "cancel-plugin-scan") {
          await cancelDriver();
          h.api.store.dispatch(setFBLoadOrder(a.id, manual));
        }
        releaseScan.resolve();
      }
      await drain();
      if (scenario === "cancel-deferred") {
        await cancelDriver();
        h.api.store.dispatch(setFBLoadOrder(a.id, manual));
        await drain();
      }
      expect(i.mPendingInstalls.size).toBe(0);
      expect(manager.getActiveInstallations()).toEqual([]);
      expect(i.mInstallLimit.mLimit).toBe(5);
      expect(i.mDependencyPipelineLimit.mLimit).toBe(10);
      const s = h.getState();
      const result = {
        scenario,
        a: loadOrderForProfile(s, a.id).map((v) => v.id),
        b: loadOrderForProfile(s, b.id).map((v) => v.id),
        deployments,
        enabledInA: s.persistent.profiles[a.id].modState.member?.enabled,
        enabledInB: s.persistent.profiles[b.id].modState.member?.enabled,
      };

      expect(result.enabledInA).toBe(true);
      expect(result.enabledInB).not.toBe(true);
      expect(h.errorNotifications).toEqual([]);
      expect(await fs.readFile(path.join(staging, "member", "payload.txt"), "utf8")).toBe(
        "existing installed member",
      );
      expect((await fs.stat(archive)).size).toBe(archiveSize);
      expect({ a: result.a, b: result.b, deployments }).toEqual({
        a: (scenario.startsWith("cancel-") ? manual : incoming).map((v) => v.id),
        b: oldB.map((v) => v.id),
        deployments: [a.id],
      });
      expect(completions).toEqual([[game, collection.id, scenario === "manual-recommended", a.id]]);
      expect(deployCallback).toHaveBeenCalledTimes(1);
      expect(scans).toBe(scenario.endsWith("plugin-scan") ? 1 : 0);
      const retired = scenario.startsWith("cancel-");
      expect(completed).toHaveBeenCalledTimes(switched || retired ? 0 : 1);
      expect(h.dispatched.filter((action) => action.type === "SET_PLUGIN_ENABLED")).toHaveLength(
        switched || retired ? 0 : 1,
      );
      if (switched) {
        h.setState((s) => {
          s.settings.profiles.activeProfileId = a.id;
          s.settings.profiles.lastActiveProfile[game] = a.id;
        });
        await h.emitAndAwait("profile-did-change", a.id);
        await drain();
        expect(completed).toHaveBeenCalledTimes(retired ? 0 : 1);
        expect(h.dispatched.filter((action) => action.type === "SET_PLUGIN_ENABLED")).toHaveLength(
          retired ? 0 : 1,
        );
        expect(loadOrderForProfile(h.getState(), a.id)).toEqual(retired ? manual : incoming);
        await h.emitAndAwait("profile-did-change", a.id);
        await drain();
        expect(completed).toHaveBeenCalledTimes(retired ? 0 : 1);
      }
      if (scenario === "unrelated" || scenario === "same-collection-other-owner") {
        expect(driver.currentSessionId).toBe(sessionBefore);
        expect(driver.collection?.id).toBe(scenario === "unrelated" ? unrelated.id : collection.id);
        expect(driver.profile?.id).toBe(b.id);
        expect(driver.postprocessing).toBe(false);
      }
    } finally {
      release.resolve();
      if (scenario.endsWith("deploy")) finishDeploy?.();
      releaseScan.resolve();
      await original;
      await drain();
      enabledFeature = false;
      await cancelDriver();
      await drain();
      expect(cancelRequests).toHaveLength(scenario.startsWith("manual") ? 0 : 1);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

for (const recommended of [false]) {
  test(`empty public dependency completion carries its immutable owner: recommended=${recommended}`, async () => {
    const a = makeProfile({ id: "empty-owner-a", gameId: "skyrimse" });
    const b = makeProfile({ id: "empty-owner-b", gameId: a.gameId });
    const collection = makeMod({ id: "empty-collection", type: "collection", rules: [] });
    const h = makeApiHarness({
      profiles: { [a.id]: a, [b.id]: b },
      activeProfileId: b.id,
      lastActiveProfile: { [a.gameId]: b.id },
      mods: { [a.gameId]: { [collection.id]: collection } },
    });
    const manager = new InstallManager(h.api, () => "unused-empty-dependency-path");
    const completed = vi.fn();
    h.api.events.on("did-install-dependencies", completed);
    await h.emitAndAwait("install-from-dependencies", collection.id, [], recommended, a.id);
    expect(completed).toHaveBeenCalledExactlyOnceWith(a.gameId, collection.id, recommended, a.id);
    expect(manager.getActiveInstallations()).toEqual([]);
    const internals = managerInternals(manager);
    expect(internals.mPendingInstalls.size).toBe(0);
    expect(internals.mInstallLimit.mLimit).toBe(5);
    expect(internals.mDependencyPipelineLimit.mLimit).toBe(10);
  });
}
