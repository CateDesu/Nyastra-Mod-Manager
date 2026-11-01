import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import PromiseBB from "bluebird";
import Zip from "node-7z";
import { afterEach, expect, vi } from "vitest";

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
} from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import * as folderSize from "../../util/calculateFolderSize";
import { UserCanceled } from "../../util/CustomErrors";
import * as errorHandling from "../../util/errorHandling";
import * as native from "../../util/fs";
import { downloadPathForGame } from "../../util/selectors";
import { getModTypeExtensions } from "../gamemode_management/util/modTypeExtensions";
import * as profileActions from "../profile_management/actions/profiles";
import { profilesReducer } from "../profile_management/reducers/profiles";
import InstallContext from "./InstallContext";
import InstallManager from "./InstallManager";
import type { IInstruction } from "./types/IInstallResult";
import { registerAttributeExtractor } from "./util/filterModInfo";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const originalModTypes = [...getModTypeExtensions()];
let attributeHook: ((modPath: string) => Promise<void>) | undefined;
registerAttributeExtractor(100, async (_info, modPath) => {
  await attributeHook?.(modPath);
  return {};
});
afterEach(() => {
  attributeHook = undefined;
  getModTypeExtensions().splice(0, getModTypeExtensions().length, ...originalModTypes);
  vi.restoreAllMocks();
});

async function fixture(recommended = false, nested = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-running-install-"));
  const game = "skyrimse";
  registerHarnessGame(game);
  const profile = makeProfile({ id: "running-owner", gameId: game });
  const rule = makeRule({
    type: recommended ? "recommends" : "requires",
    reference: { tag: "running-member", gameId: game },
  });
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
  const payload = "real payload from a running dependency";
  const source = path.join(root, "payload.txt");
  fs.writeFileSync(source, payload);
  const archive = path.join(directory, "member.zip");
  const nestedArchive = path.join(root, "nested.zip");
  if (nested) await new Zip().add(nestedArchive, [source]);
  await new Zip().add(archive, nested ? [source, nestedArchive] : [source]);
  const archiveBefore = fs.readFileSync(archive);
  h.setState((state) => {
    state.persistent.downloads.files.archive = makeDownload({
      id: "archive",
      state: "finished",
      size: archiveBefore.length,
      fileMD5: "0123456789abcdef0123456789abcdef",
      game: [game],
      localPath: "member.zip",
      modInfo: { referenceTag: "running-member" },
    });
  });
  const work: Promise<unknown>[] = [];
  const track = <T>(promise: PromiseLike<T>): Promise<T> => {
    const p = Promise.resolve(promise);
    work.push(p);
    void p.catch(() => undefined);
    return p;
  };
  h.api.withPrePost =
    (_name, callback) =>
    (...args) => {
      const promise = callback(...args);
      track(promise);
      return promise;
    };
  const setEnabled = profileActions.setModsEnabled;
  vi.spyOn(profileActions, "setModsEnabled").mockImplementation((...args) => {
    const promise = setEnabled(...args);
    track(promise);
    return promise;
  });
  const activity = errorHandling.withTrackedActivity;
  vi.spyOn(errorHandling, "withTrackedActivity").mockImplementation((...args) =>
    track(activity(...args)),
  );
  h.api.emitAndAwait = (async (event: string, ...args: unknown[]) => {
    await h.emitAndAwait(event, ...args);
    return [];
  }) as typeof h.api.emitAndAwait;
  h.api.lookupModMeta = vi.fn(() => PromiseBB.resolve([]));
  h.api.lookupModReference = vi.fn(() => PromiseBB.resolve([]));
  vi.spyOn(notifications, "showDialog").mockImplementation(
    (_type, title) => () =>
      PromiseBB.resolve({
        action: title === "Install Recommendations" ? "Install All" : "Install",
        input: {},
      }),
  );
  const manager = new InstallManager(h.api, () => staging);
  const instructions: IInstruction[] = [
    { type: "copy", source: "payload.txt", destination: "payload.txt" },
    { type: "generatefile", destination: "generated/later.txt", data: "generated payload" },
    { type: "attribute", key: "runningInstaller", value: true },
  ];
  const supported = vi.fn(async () => ({ supported: true, requiredFiles: [] }));
  const installer = vi.fn(
    async (
      _files: string[],
      _temp: string,
      _game: string,
      _progress: (percent: number) => void,
    ) => ({ instructions }),
  );
  manager.addInstaller("running-copy", 0, supported, installer);
  const i = managerInternals(manager);
  const submitted = [deferred(), deferred()];
  const installWork: Promise<unknown>[] = [];
  for (const limiter of [i.mInstallLimit, i.mDependencyPipelineLimit]) {
    const original = limiter.do.bind(limiter);
    vi.spyOn(limiter, "do").mockImplementation((fn) => {
      const promise = track(original(fn));
      if (limiter === i.mInstallLimit) {
        installWork.push(promise);
        submitted[installWork.length - 1]?.resolve();
      }
      return promise;
    });
  }
  const size = i.setModSize.bind(manager);
  vi.spyOn(i, "setModSize").mockImplementation((...args) => track(size(...args)));
  const callbacks = vi.fn();
  const callbackDelivered = deferred();
  const install = manager.install.bind(manager);
  vi.spyOn(manager, "install").mockImplementation((...args) => {
    const callback = args[7];
    args[7] = (...values) => {
      callbacks(...values);
      callback(...values);
      callbackDelivered.resolve();
    };
    return install(...args);
  });
  const completion = vi.fn();
  const installedEvent = vi.fn();
  const cancellations = vi.fn();
  h.api.events.on("did-install-dependencies", completion);
  h.api.events.on("did-install-mod", installedEvent);
  h.api.onAsync("cancel-dependency-install", cancellations);
  const attempts: Promise<void>[] = [];
  const start = () => {
    const promise = h.emitAndAwait(
      "install-from-dependencies",
      "source",
      [rule],
      recommended,
      profile.id,
    );
    attempts.push(promise);
    return promise;
  };
  const cancel = () => h.emitAndAwait("cancel-dependency-install", "source");
  const drain = async () => {
    let n = -1;
    while (n !== work.length) {
      n = work.length;
      await Promise.allSettled(work);
      await tick();
    }
  };
  const checkIdle = () => {
    expect(manager.getActiveInstallations()).toEqual([]);
    expect(i.mPendingInstalls.size).toBe(0);
    expect(i.mInstallLimit.mLimit).toBe(5);
    expect(i.mDependencyPipelineLimit.mLimit).toBe(10);
    expect(manager["mInstallLimit"]["mNext"]).toBeUndefined();
    expect(manager["mDependencyPipelineLimit"]["mNext"]).toBeUndefined();
    expect(manager["mRunningInstalls"]?.size ?? 0).toBe(0);
  };
  const check = (installed: boolean) => {
    checkIdle();
    const mods = Object.values(h.getState().persistent.mods[game]).filter(
      (mod) => mod.id !== "source",
    );
    expect(mods.map((mod) => ({ id: mod.id, state: mod.state }))).toEqual(
      installed ? [{ id: "member", state: "installed" }] : [],
    );
    expect(fs.existsSync(path.join(staging, "member.installing"))).toBe(false);
    expect(fs.existsSync(path.join(staging, "member"))).toBe(installed);
    if (installed) {
      expect(fs.readFileSync(path.join(staging, "member/payload.txt"), "utf8")).toBe(payload);
      expect(fs.readFileSync(path.join(staging, "member/generated/later.txt"), "utf8")).toBe(
        "generated payload",
      );
      expect(h.getState().persistent.profiles[profile.id].modState.member?.enabled).toBe(true);
      expect(mods[0].attributes.runningInstaller).toBe(true);
    } else {
      expect(h.getState().persistent.profiles[profile.id].modState.member?.enabled).not.toBe(true);
    }
    expect(fs.readFileSync(archive)).toEqual(archiveBefore);
    expect(h.errorNotifications).toEqual([]);
  };
  const cleanup = async () => {
    await cancel();
    await Promise.allSettled(attempts);
    await drain();
    try {
      checkIdle();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  return {
    ...h,
    manager,
    i,
    game,
    profile,
    archive,
    root,
    staging,
    instructions,
    supported,
    installer,
    track,
    start,
    cancel,
    drain,
    check,
    cleanup,
    callbacks,
    callbackDelivered,
    completion,
    installedEvent,
    cancellations,
    submitted,
    installWork,
  };
}

for (const boundary of [
  "lookup",
  "will-install",
  "metadata",
  "extraction-preparation",
  "support",
  "installer",
  "mod-type",
  "instructions",
  "generate-directory",
  "registration",
  "size",
] as const) {
  for (const canceled of [false, true]) {
    test(`public running cancellation: ${boundary}, canceled=${canceled}`, async () => {
      const h = await fixture();
      const entered = deferred();
      const release = deferred();
      const hold = async () => {
        entered.resolve();
        await release.promise;
      };
      if (boundary === "lookup")
        h.api.lookupModReference = vi.fn(() => PromiseBB.resolve(hold()).then(() => []));
      if (boundary === "will-install") h.api.onAsync("will-install-mod", hold);
      if (boundary === "metadata")
        h.api.lookupModMeta = vi.fn(() => PromiseBB.resolve(hold()).then(() => []));
      if (boundary === "support")
        h.supported.mockImplementation(async () => {
          await hold();
          return { supported: true, requiredFiles: [] };
        });
      if (boundary === "installer")
        h.installer.mockImplementation(async () => {
          await hold();
          return { instructions: h.instructions };
        });
      if (boundary === "mod-type")
        getModTypeExtensions().unshift({
          typeId: "running-type",
          priority: -1,
          isSupported: (game) => game === h.game,
          getPath: () => "",
          test: () => PromiseBB.resolve(hold()).then(() => false),
          options: {},
        });
      if (boundary === "registration")
        attributeHook = async (modPath) => {
          if (modPath !== undefined) await hold();
        };
      if (boundary === "size") {
        const size = folderSize.default;
        vi.spyOn(folderSize, "default").mockImplementation(async (...args) => {
          const result = await size(...args);
          await hold();
          return result;
        });
      }
      if (boundary === "instructions") {
        const link = native.linkAsync;
        vi.spyOn(native, "linkAsync").mockImplementation((...args) =>
          PromiseBB.resolve(
            h.track(
              (async () => {
                await link(...args);
                await hold();
              })(),
            ),
          ),
        );
      }
      if (boundary === "generate-directory") {
        const ensure = native.ensureDirAsync;
        vi.spyOn(native, "ensureDirAsync").mockImplementation((...args) =>
          PromiseBB.resolve(
            h.track(
              (async () => {
                await ensure(...args);
                if (args[0] === path.join(h.staging, "member/generated")) await hold();
              })(),
            ),
          ),
        );
      }
      if (boundary === "extraction-preparation") {
        const remove = native.removeAsync;
        vi.spyOn(native, "removeAsync").mockImplementation((...args) =>
          PromiseBB.resolve(
            h.track(
              (async () => {
                await remove(...args);
                if (args[0] === path.join(h.staging, "member.installing")) await hold();
              })(),
            ),
          ),
        );
      }
      const extractions = vi.spyOn(Zip.prototype, "extractFull");
      const writes = vi.spyOn(native, "writeFileAsync");
      const commits = vi.spyOn(native, "renameAsync");
      const attempt = h.start();
      try {
        await entered.promise;
        if (canceled) await h.cancel();
        release.resolve();
        await attempt;
        await h.drain();
        expect(h.cancellations).toHaveBeenCalledTimes(canceled ? 1 : 0);
        expect(h.callbacks).toHaveBeenCalledTimes(boundary === "lookup" && canceled ? 0 : 1);
        if (h.callbacks.mock.calls.length > 0) {
          expect(h.callbacks.mock.calls[0][0]).toEqual(canceled ? expect.any(UserCanceled) : null);
          expect(h.callbacks.mock.calls[0][1]).toBe(canceled ? null : "member");
        }
        expect(h.completion).toHaveBeenCalledTimes(canceled ? 0 : 1);
        expect(h.installedEvent).toHaveBeenCalledTimes(canceled ? 0 : 1);
        const beforeInstaller = [
          "lookup",
          "will-install",
          "metadata",
          "extraction-preparation",
          "support",
        ].includes(boundary);
        expect(h.installer).toHaveBeenCalledTimes(canceled && beforeInstaller ? 0 : 1);
        const beforeExtraction = [
          "lookup",
          "will-install",
          "metadata",
          "extraction-preparation",
        ].includes(boundary);
        expect(extractions).toHaveBeenCalledTimes(canceled && beforeExtraction ? 0 : 1);
        if (["instructions", "generate-directory"].includes(boundary)) {
          expect(
            [
              ...writes.mock.calls.map(([name]) => name),
              ...commits.mock.calls.map(([, destination]) => destination),
            ].filter((name) => name === path.join(h.staging, "member/generated/later.txt")),
          ).toHaveLength(canceled ? 0 : 1);
        }
        h.check(!canceled);
      } finally {
        release.resolve();
        await h.cleanup();
      }
    });
  }
}

for (const recommended of [false, true]) {
  for (const rejects of [false, true]) {
    test(`canceled installer settles before its retry: recommended=${recommended}, rejects=${rejects}`, async () => {
      const h = await fixture(recommended);
      const entered = deferred();
      const release = deferred();
      const cleanupEntered = deferred();
      const cleanupRelease = deferred();
      const retryEntered = deferred();
      const retryRelease = deferred();
      let cleanupComplete = false;
      const remove = native.removeAsync;
      vi.spyOn(native, "removeAsync").mockImplementation((...args) =>
        PromiseBB.resolve(
          h.track(
            (async () => {
              if (args[0] === path.join(h.staging, "member") && !cleanupComplete) {
                cleanupEntered.resolve();
                await cleanupRelease.promise;
                await remove(...args);
                cleanupComplete = true;
              } else await remove(...args);
            })(),
          ),
        ),
      );
      h.installer
        .mockImplementationOnce(async (_files, temp, _game, progress) => {
          expect(fs.readFileSync(path.join(temp, "payload.txt"), "utf8")).toBe(
            "real payload from a running dependency",
          );
          entered.resolve();
          await release.promise;
          progress(75);
          if (rejects) throw new Error("obsolete installer failed");
          return { instructions: h.instructions };
        })
        .mockImplementationOnce(async (_files, temp) => {
          expect(cleanupComplete).toBe(true);
          expect(fs.readFileSync(path.join(temp, "payload.txt"), "utf8")).toBe(
            "real payload from a running dependency",
          );
          retryEntered.resolve();
          await retryRelease.promise;
          return { instructions: h.instructions };
        });
      const first = h.start();
      try {
        await entered.promise;
        await h.cancel();
        const waiting = deferred();
        const retryStarted = deferred();
        const running = h.manager["mRunningInstalls"];
        const key = "archive";
        const previous = running.get(key);
        running.set(
          key,
          new Proxy(previous, {
            get(target, property, receiver) {
              if (property === "then")
                return (...args: Parameters<Promise<void>["then"]>) => {
                  waiting.resolve();
                  return target.then(...args);
                };
              return Reflect.get(target, property, receiver);
            },
          }),
        );
        h.api.onAsync("will-install-mod", async () => {
          retryStarted.resolve();
        });
        const retry = h.start();
        await h.submitted[1].promise;
        const boundary = await Promise.race([
          waiting.promise.then(() => "waiting"),
          retryStarted.promise.then(() => "running"),
        ]);
        expect(boundary).toBe("waiting");
        expect(h.installer).toHaveBeenCalledTimes(1);
        release.resolve();
        await cleanupEntered.promise;
        expect(h.installer).toHaveBeenCalledTimes(1);
        cleanupRelease.resolve();
        await retryEntered.promise;
        await first;
        await Promise.allSettled([h.installWork[0]]);
        expect(h.callbacks).toHaveBeenCalledTimes(1);
        expect(h.callbacks.mock.calls[0]).toEqual([expect.any(UserCanceled), null]);
        expect(h.manager.getActiveInstallations()).toHaveLength(1);
        retryRelease.resolve();
        await retry;
        await h.drain();
        expect(h.callbacks.mock.calls).toEqual([
          [expect.any(UserCanceled), null],
          [null, "member"],
        ]);
        expect(h.cancellations).toHaveBeenCalledTimes(1);
        expect(h.completion).toHaveBeenCalledTimes(1);
        expect(h.installedEvent).toHaveBeenCalledTimes(1);
        expect(h.installer).toHaveBeenCalledTimes(2);
        h.check(true);
      } finally {
        release.resolve();
        cleanupRelease.resolve();
        retryRelease.resolve();
        await h.cleanup();
      }
    });
  }
}

for (const canceled of [false, true]) {
  test(`nested installer retains the original owner: canceled=${canceled}`, async () => {
    const h = await fixture(false, true);
    const entered = deferred();
    const release = deferred();
    h.installer
      .mockImplementationOnce(async (_files, temp) => ({
        instructions: [
          { type: "copy", source: "payload.txt", destination: "payload.txt" },
          { type: "submodule", path: path.join(temp, "nested.zip"), submoduleType: "" },
        ],
      }))
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { instructions: h.instructions };
      });
    const writes = vi.spyOn(native, "writeFileAsync");
    const commits = vi.spyOn(native, "renameAsync");
    const attempt = h.start();
    try {
      await entered.promise;
      if (canceled) await h.cancel();
      release.resolve();
      await attempt;
      await h.drain();
      expect(h.installer).toHaveBeenCalledTimes(2);
      expect(h.callbacks.mock.calls).toEqual([
        [canceled ? expect.any(UserCanceled) : null, canceled ? null : "member"],
      ]);
      expect(h.cancellations).toHaveBeenCalledTimes(canceled ? 1 : 0);
      expect(h.completion).toHaveBeenCalledTimes(canceled ? 0 : 1);
      expect(h.installedEvent).toHaveBeenCalledTimes(canceled ? 0 : 1);
      expect(
        [
          ...writes.mock.calls.map(([name]) => name),
          ...commits.mock.calls.map(([, destination]) => destination),
        ].filter((name) => name === path.join(h.staging, "member/generated/later.txt")),
      ).toHaveLength(canceled ? 0 : 1);
      h.check(!canceled);
      expect(fs.readdirSync(h.staging).filter((name) => name.endsWith(".installing"))).toEqual([]);
    } finally {
      release.resolve();
      await h.cleanup();
    }
  });

  test(`late installer error reporting retains the owner: canceled=${canceled}`, async () => {
    const h = await fixture();
    const entered = deferred();
    const release = deferred();
    const reports = vi.spyOn(InstallContext.prototype, "reportError");
    h.installer.mockRejectedValue(new Error("installer failed before cancellation"));
    h.api.genMd5Hash = vi.fn(() => {
      entered.resolve();
      return PromiseBB.resolve(release.promise).then(() => ({
        md5sum: "0123456789abcdef0123456789abcdef",
        numBytes: fs.statSync(h.archive).size,
      }));
    });
    const attempt = h.start();
    try {
      await entered.promise;
      if (canceled) await h.cancel();
      release.resolve();
      await h.callbackDelivered.promise;
      if (!canceled) await h.cancel();
      await attempt;
      await h.drain();
      expect(h.api.genMd5Hash).toHaveBeenCalledTimes(1);
      expect(h.installer).toHaveBeenCalledTimes(1);
      expect(h.callbacks).toHaveBeenCalledTimes(1);
      expect(h.callbacks.mock.calls[0][0]).toEqual(
        canceled
          ? expect.any(UserCanceled)
          : expect.objectContaining({ message: "installer failed before cancellation" }),
      );
      expect(h.cancellations).toHaveBeenCalledTimes(1);
      expect(h.completion).toHaveBeenCalledTimes(0);
      expect(h.installedEvent).toHaveBeenCalledTimes(0);
      expect(reports).toHaveBeenCalledTimes(canceled ? 0 : 1);
      if (!canceled) expect(reports.mock.calls[0][0]).toBe("Installation failed");
      h.check(false);
    } finally {
      release.resolve();
      await h.cleanup();
    }
  });

  test(`installer progress callback retains the owner: canceled=${canceled}`, async () => {
    const h = await fixture();
    const entered = deferred();
    const release = deferred();
    const progress = vi.spyOn(InstallContext.prototype, "setProgress");
    let before = 0;
    let after = 0;
    h.installer.mockImplementation(async (_files, _temp, _game, update) => {
      before = progress.mock.calls.length;
      entered.resolve();
      await release.promise;
      update(75);
      after = progress.mock.calls.length;
      return { instructions: h.instructions };
    });
    const attempt = h.start();
    try {
      await entered.promise;
      if (canceled) await h.cancel();
      release.resolve();
      await attempt;
      await h.drain();
      expect(after - before).toBe(canceled ? 0 : 1);
      expect(h.installer).toHaveBeenCalledTimes(1);
      expect(h.callbacks.mock.calls).toEqual([
        [canceled ? expect.any(UserCanceled) : null, canceled ? null : "member"],
      ]);
      expect(h.cancellations).toHaveBeenCalledTimes(canceled ? 1 : 0);
      expect(h.completion).toHaveBeenCalledTimes(canceled ? 0 : 1);
      expect(h.installedEvent).toHaveBeenCalledTimes(canceled ? 0 : 1);
      h.check(!canceled);
    } finally {
      release.resolve();
      await h.cleanup();
    }
  });
}

for (const recommended of [false, true]) {
  test(`settled cancellation permits retry: recommended=${recommended}`, async () => {
    const h = await fixture(recommended);
    const entered = deferred();
    const release = deferred();
    h.installer.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { instructions: h.instructions };
    });
    const original = h.start();
    try {
      await entered.promise;
      await h.cancel();
      release.resolve();
      await original;
      await h.drain();
      expect(h.callbacks.mock.calls).toEqual([[expect.any(UserCanceled), null]]);
      h.check(false);
      await h.start();
      await h.drain();
      expect(h.callbacks.mock.calls).toEqual([
        [expect.any(UserCanceled), null],
        [null, "member"],
      ]);
      expect(h.cancellations).toHaveBeenCalledTimes(1);
      expect(h.installer).toHaveBeenCalledTimes(2);
      expect(h.completion).toHaveBeenCalledTimes(1);
      expect(h.installedEvent).toHaveBeenCalledTimes(1);
      h.check(true);
    } finally {
      release.resolve();
      await h.cleanup();
    }
  });
}
