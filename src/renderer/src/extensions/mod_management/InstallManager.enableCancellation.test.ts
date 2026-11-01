import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import Zip from "node-7z";
import { afterEach, expect, test, vi } from "vitest";

import * as notifications from "../../actions/notifications";
import {
  makeApiHarness,
  makeDownload,
  makeGameStored,
  makeMod,
  makeProfile,
  makeRule,
  managerInternals,
  registerHarnessGame,
  resetHarnessRegistries,
} from "../../test-utils/builders";
import { UserCanceled } from "../../util/CustomErrors";
import * as errorHandling from "../../util/errorHandling";
import { downloadPathForGame } from "../../util/selectors";
import { profilesReducer } from "../profile_management/reducers/profiles";
import InstallContext from "./InstallContext";
import InstallManager from "./InstallManager";
import type { IInstruction } from "./types/IInstallResult";

afterEach(() => {
  resetHarnessRegistries();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// One harness retains the API cached by the real setModsEnabled across the retry.
test("public enable hook cancellation settles before a successful retry", async () => {
  await import("./index.js");
  expect(globalThis.Promise).toBe(Bluebird);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-enable-cancel-"));
  const game = "skyrimse";
  registerHarnessGame(game);
  const profile = makeProfile({ id: "enable-owner", gameId: game });
  const rule = makeRule({ type: "requires", reference: { tag: "enable-member", gameId: game } });
  const h = makeApiHarness(
    {
      knownGames: [makeGameStored()],
      profiles: { [profile.id]: profile },
      activeProfileId: profile.id,
      mods: { [game]: { source: makeMod({ id: "source", type: "collection", rules: [rule] }) } },
    },
    [{ path: ["persistent", "profiles"], reducer: profilesReducer }],
  );
  const staging = path.join(root, "staging");
  h.setState((state) => {
    state.settings.downloads.path = path.join(root, "downloads");
    state.settings.mods.installPath[game] = staging;
    state.settings.mods.activator[game] = "empty";
    state.settings.automation = {
      deploy: false,
      install: false,
      enable: true,
      start: false,
      minimized: false,
    };
    state.session.mods = {
      changes: [],
      updatingMods: {},
      deploymentProblems: [],
      deploymentFailures: {},
    };
  });
  const directory = downloadPathForGame(h.getState(), game);
  fs.mkdirSync(directory, { recursive: true });
  const payload = "real payload through the public enable hook";
  const source = path.join(root, "payload.txt");
  fs.writeFileSync(source, payload);
  const archive = path.join(directory, "member.zip");
  await new Zip().add(archive, [source]);
  const archiveBefore = fs.readFileSync(archive);
  h.setState((state) => {
    state.persistent.downloads.files.archive = makeDownload({
      id: "archive",
      state: "finished",
      size: archiveBefore.length,
      fileMD5: "0123456789abcdef0123456789abcdef",
      game: [game],
      localPath: "member.zip",
      modInfo: { referenceTag: "enable-member" },
    });
  });
  const work: Array<Promise<unknown>> = [];
  const track = <T>(promise: PromiseLike<T>): Promise<T> => {
    const observed = Promise.resolve(promise);
    work.push(observed);
    void observed.catch(() => undefined);
    return observed;
  };
  // Mirror ExtensionManager's will, callback, did order without replacing setModsEnabled.
  h.api.withPrePost =
    (_name, callback) =>
    (...args) =>
      track(
        (async () => {
          await h.emitAndAwait(`will-${_name}`, ...args);
          const result = await Promise.resolve(callback(...args));
          await h.emitAndAwait(`did-${_name}`, result, ...args);
          return result;
        })(),
      );
  h.api.emitAndAwait = (async (event: string, ...args: unknown[]) => {
    await h.emitAndAwait(event, ...args);
    return [];
  }) as typeof h.api.emitAndAwait;
  h.api.lookupModMeta = vi.fn<typeof h.api.lookupModMeta>(() => Bluebird.resolve([]));
  h.api.lookupModReference = vi.fn<typeof h.api.lookupModReference>(() => Bluebird.resolve([]));
  vi.spyOn(notifications, "showDialog").mockImplementation(
    () => () => Bluebird.resolve({ action: "Install", input: {} }),
  );
  const activity = errorHandling.withTrackedActivity;
  vi.spyOn(errorHandling, "withTrackedActivity").mockImplementation((...args) =>
    track(activity(...args)),
  );
  const manager = new InstallManager(h.api, () => staging);
  const i = managerInternals(manager);
  const instructions: IInstruction[] = [
    { type: "copy", source: "payload.txt", destination: "payload.txt" },
    { type: "generatefile", destination: "generated/later.txt", data: "generated payload" },
  ];
  const installer = vi.fn<() => Promise<{ instructions: IInstruction[] }>>(async () => ({
    instructions,
  }));
  manager.addInstaller(
    "enable-copy",
    0,
    async () => ({ supported: true, requiredFiles: [] }),
    installer,
  );
  const limiterCalls = [0, 0];
  for (const [index, limiter] of [i.mInstallLimit, i.mDependencyPipelineLimit].entries()) {
    const original = limiter.do.bind(limiter);
    vi.spyOn(limiter, "do").mockImplementation((fn) => {
      limiterCalls[index]++;
      return track(original(fn));
    });
  }
  const size = i.setModSize.bind(manager);
  vi.spyOn(i, "setModSize").mockImplementation((...args) => track(size(...args)));
  const extract = Zip.prototype.extractFull;
  vi.spyOn(Zip.prototype, "extractFull").mockImplementation(function (this: Zip, ...args) {
    const original = extract.apply(this, args);
    void track(original);
    return original;
  });
  const aggregator = manager["mNotificationAggregator"];
  const stopAggregation = aggregator.stopAggregation.bind(aggregator);
  vi.spyOn(aggregator, "stopAggregation").mockImplementation((...args) =>
    track(stopAggregation(...args)),
  );
  // Await the original delayed indicator notification as part of the installation tail.
  const stopIndicator = InstallContext.prototype.stopIndicator;
  vi.spyOn(InstallContext.prototype, "stopIndicator").mockImplementation(function (
    this: InstallContext,
    ...args
  ) {
    const schedule = globalThis.setTimeout;
    const timerSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...values) => {
        const done = deferred();
        void track(done.promise);
        return schedule(() => {
          try {
            callback(...values);
          } finally {
            done.resolve();
          }
        }, delay);
      });
    try {
      return stopIndicator.apply(this, args);
    } finally {
      timerSpy.mockRestore();
    }
  });
  const callbacks = vi.fn<Parameters<InstallManager["install"]>[7]>();
  const install = manager.install.bind(manager);
  vi.spyOn(manager, "install").mockImplementation((...args) => {
    const callback = args[7];
    args[7] = (...values) => {
      callbacks(...values);
      callback(...values);
    };
    return install(...args);
  });
  const completion = vi.fn<(...args: unknown[]) => void>();
  const installed = vi.fn<(...args: unknown[]) => void>();
  const enabled = vi.fn<(...args: unknown[]) => void>();
  const canceled = vi.fn<() => Promise<void>>(() => Promise.resolve());
  h.api.events.on("did-install-dependencies", completion);
  h.api.events.on("did-install-mod", installed);
  h.api.events.on("mods-enabled", enabled);
  h.api.onAsync("cancel-dependency-install", canceled);
  const entered = deferred();
  const release = deferred();
  const hook = vi.fn<() => Promise<void>>(async () => {
    entered.resolve();
    await release.promise;
  });
  h.api.onAsync("will-enable-mods", hook);
  const cancel = () => track(h.emitAndAwait("cancel-dependency-install", "source"));
  const start = () =>
    track(h.emitAndAwait("install-from-dependencies", "source", [rule], false, profile.id));
  const drain = async () => {
    let count = -1;
    while (count !== work.length) {
      count = work.length;
      // Explicit outcomes work with both native promises and the built-in Bluebird global.
      const errors = await Promise.all(
        work.map((promise) =>
          promise.then(
            () => undefined,
            (err: unknown) => err,
          ),
        ),
      );
      expect(errors.filter((err) => err !== undefined && !(err instanceof UserCanceled))).toEqual(
        [],
      );
      await new Promise<void>((done) => setImmediate(done));
    }
    await Promise.all([
      manager["mInstallLimit"]["mEndOfQueue"],
      manager["mDependencyPipelineLimit"]["mEndOfQueue"],
    ]);
    await Promise.all(manager["mRunningInstalls"].values());
  };
  const checkIdle = () => {
    expect(manager.getActiveInstallations()).toEqual([]);
    expect(i.mPendingInstalls.size).toBe(0);
    expect(manager["mRunningInstalls"].size).toBe(0);
    expect(manager["mDependencyAttempts"].size).toBe(0);
    expect(manager["mDependencyInstalls"]).toEqual({});
    expect([i.mInstallLimit.mLimit, i.mDependencyPipelineLimit.mLimit]).toEqual([5, 10]);
    expect(manager["mInstallLimit"]["mNext"]).toBeUndefined();
    expect(manager["mDependencyPipelineLimit"]["mNext"]).toBeUndefined();
    expect(aggregator["mActiveAggregations"].size).toBe(0);
    expect(aggregator["mTimeouts"]).toEqual({});
    expect(aggregator["mAddNotificationQueue"]).toEqual({});
  };
  try {
    const attempt = start();
    await entered.promise;
    expect(manager.getActiveInstallations()).toHaveLength(1);
    expect(h.getState().persistent.mods[game].member.state).toBe("installed");
    expect(h.getState().persistent.profiles[profile.id].modState.member?.enabled).not.toBe(true);
    expect(fs.readFileSync(path.join(staging, "member/payload.txt"), "utf8")).toBe(payload);
    await cancel();
    expect(manager.getActiveInstallations()).toEqual([]);
    release.resolve();
    await attempt;
    await drain();
    checkIdle();
    expect(callbacks.mock.calls).toEqual([[expect.any(UserCanceled), null]]);
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(completion).toHaveBeenCalledTimes(0);
    expect(installed).toHaveBeenCalledTimes(0);
    expect(enabled).toHaveBeenCalledTimes(0);
    expect(h.getState().persistent.profiles[profile.id].modState.member?.enabled).not.toBe(true);
    expect(h.getState().persistent.mods[game].member).toBeUndefined();
    expect(fs.existsSync(path.join(staging, "member"))).toBe(false);
    expect(fs.existsSync(path.join(staging, "member.installing"))).toBe(false);
    expect(fs.readFileSync(archive)).toEqual(archiveBefore);
    expect(h.errorNotifications).toEqual([]);
    expect(h.notifications.filter((notification) => notification.type === "error")).toEqual([]);
    expect(limiterCalls).toEqual([1, 1]);
    await start();
    await drain();
    checkIdle();
    expect(callbacks.mock.calls).toEqual([
      [expect.any(UserCanceled), null],
      [null, "member"],
    ]);
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(completion).toHaveBeenCalledTimes(1);
    expect(installed).toHaveBeenCalledTimes(1);
    expect(enabled).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(installer).toHaveBeenCalledTimes(2);
    expect(limiterCalls).toEqual([2, 2]);
    expect(h.getState().persistent.mods[game].member.state).toBe("installed");
    expect(h.getState().persistent.profiles[profile.id].modState.member.enabled).toBe(true);
    expect(fs.readFileSync(path.join(staging, "member/payload.txt"), "utf8")).toBe(payload);
    expect(fs.readFileSync(path.join(staging, "member/generated/later.txt"), "utf8")).toBe(
      "generated payload",
    );
    expect(fs.existsSync(path.join(staging, "member.installing"))).toBe(false);
    expect(fs.readFileSync(archive)).toEqual(archiveBefore);
    expect(h.errorNotifications).toEqual([]);
    expect(h.notifications.filter((notification) => notification.type === "error")).toEqual([]);
  } finally {
    release.resolve();
    await cancel();
    await drain();
    try {
      checkIdle();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
