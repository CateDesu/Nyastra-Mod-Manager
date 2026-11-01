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
import { UserCanceled } from "../../util/CustomErrors";
import * as errorHandling from "../../util/errorHandling";
import * as native from "../../util/fs";
import { downloadPathForGame } from "../../util/selectors";
import { getModTypeExtensions } from "../gamemode_management/util/modTypeExtensions";
import * as profileActions from "../profile_management/actions/profiles";
import { profilesReducer } from "../profile_management/reducers/profiles";
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
  const other = path.join(root, "other-payload.txt");
  fs.writeFileSync(other, payload);
  const archive = path.join(directory, "member.zip");
  const nestedArchive = path.join(root, "nested.zip");
  if (nested) await new Zip().add(nestedArchive, [source]);
  await new Zip().add(archive, nested ? [source, nestedArchive] : [source, other]);
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
    checkIdle,
    archiveBefore,
    payload,
    work,
  };
}

for (const scenario of [
  "shared-generated",
  "shared-unchanged",
  "distinct-generated",
  "separate-generated",
] as const) {
  test(`public installer generatefile keeps independent destinations: ${scenario}`, async () => {
    const h = await fixture();
    const generated = scenario !== "shared-unchanged";
    h.instructions.splice(
      0,
      h.instructions.length,
      { type: "copy", source: "payload.txt", destination: "selected.cfg" },
      {
        type: "copy",
        source: scenario === "distinct-generated" ? "other-payload.txt" : "payload.txt",
        destination: "untouched.cfg",
      },
      ...(generated
        ? [
            {
              type: "generatefile" as const,
              destination: scenario === "separate-generated" ? "new.cfg" : "selected.cfg",
              data: "custom generated contents",
            },
          ]
        : []),
      { type: "attribute", key: "runningInstaller", value: true },
    );
    const destination = path.join(h.staging, "member");
    const snapshots: Array<{
      selected: number;
      sibling: number;
      mode: number;
      selectedBytes: string;
      siblingBytes: string;
    }> = [];
    const original = h.manager["processGenerateFiles"].bind(h.manager);
    const generate = vi
      .spyOn(
        h.manager as unknown as { processGenerateFiles: typeof original },
        "processGenerateFiles",
      )
      .mockImplementation((...args) => {
        fs.chmodSync(path.join(destination, "selected.cfg"), 0o751);
        snapshots.push({
          mode: fs.statSync(path.join(destination, "selected.cfg")).mode & 0o777,
          selected: fs.statSync(path.join(destination, "selected.cfg")).ino,
          sibling: fs.statSync(path.join(destination, "untouched.cfg")).ino,
          selectedBytes: fs.readFileSync(path.join(destination, "selected.cfg"), "utf8"),
          siblingBytes: fs.readFileSync(path.join(destination, "untouched.cfg"), "utf8"),
        });
        return h.track(original(...args));
      });
    try {
      await h.start();
      await h.drain();
      h.checkIdle();
      const settled = await Promise.all(
        h.work.map((p) =>
          Promise.resolve(p).then(
            () => null,
            (e) => e,
          ),
        ),
      );
      expect(settled.filter((e) => e !== null)).toEqual([]);
      expect(h.callbacks).toHaveBeenCalledExactlyOnceWith(null, "member");
      expect(h.installer).toHaveBeenCalledTimes(1);
      expect(h.supported).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(h.completion).toHaveBeenCalledTimes(1);
      expect(h.installedEvent).toHaveBeenCalledTimes(1);
      expect(h.cancellations).toHaveBeenCalledTimes(0);
      expect(h.getState().persistent.mods[h.game].member.state).toBe("installed");
      expect(h.getState().persistent.profiles[h.profile.id].modState.member.enabled).toBe(true);
      expect(fs.readFileSync(h.archive)).toEqual(h.archiveBefore);
      expect(h.errorNotifications).toEqual([]);
      expect(fs.existsSync(destination + ".installing")).toBe(false);
      const result = {
        scenario,
        before: snapshots[0],
        selected: fs.readFileSync(path.join(destination, "selected.cfg"), "utf8"),
        sibling: fs.readFileSync(path.join(destination, "untouched.cfg"), "utf8"),
        selectedInode: fs.statSync(path.join(destination, "selected.cfg")).ino,
        siblingInode: fs.statSync(path.join(destination, "untouched.cfg")).ino,
      };
      console.log("GENERATEFILE_RESULT", JSON.stringify(result));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].selectedBytes).toBe(h.payload);
      expect(snapshots[0].siblingBytes).toBe(h.payload);
      expect(snapshots[0].selected === snapshots[0].sibling).toBe(
        scenario !== "distinct-generated",
      );
      expect(fs.statSync(path.join(destination, "selected.cfg")).mode & 0o777).toBe(0o751);
      expect(result.selectedInode === result.siblingInode).toBe(
        scenario === "shared-unchanged" || scenario === "separate-generated",
      );
      if (scenario === "separate-generated")
        expect(fs.statSync(path.join(destination, "new.cfg")).mode & 0o777).toBe(
          0o666 & ~process.umask(),
        );
      expect(result.selected).toBe(
        generated && scenario !== "separate-generated" ? "custom generated contents" : h.payload,
      );
      expect(result.sibling, "generating one destination must not overwrite another copy").toBe(
        h.payload,
      );
      if (scenario === "separate-generated")
        expect(fs.readFileSync(path.join(destination, "new.cfg"), "utf8")).toBe(
          "custom generated contents",
        );
    } finally {
      await h.cleanup();
    }
  });
}

for (const canceled of [false, true]) {
  test(`generated commit respects its running owner, canceled=${canceled}`, async () => {
    const h = await fixture();
    h.instructions.splice(
      0,
      h.instructions.length,
      { type: "copy", source: "payload.txt", destination: "selected.cfg" },
      { type: "copy", source: "payload.txt", destination: "untouched.cfg" },
      { type: "generatefile", destination: "selected.cfg", data: "custom generated contents" },
    );
    const entered = deferred();
    const release = deferred();
    const original = native.chmodAsync;
    const nativeWork: PromiseLike<unknown>[] = [];
    vi.spyOn(native, "chmodAsync").mockImplementation((filename, mode) => {
      if (path.basename(filename).startsWith("selected.cfg.") && filename.endsWith(".tmp")) {
        const operation = PromiseBB.resolve(release.promise).then(() => original(filename, mode));
        nativeWork.push(operation);
        h.track(operation);
        entered.resolve();
        return operation;
      }
      return original(filename, mode);
    });
    const rename = native.renameAsync;
    const commits = vi.fn();
    vi.spyOn(native, "renameAsync").mockImplementation((from, to) => {
      if (to === path.join(h.staging, "member/selected.cfg")) commits(from, to);
      const operation = rename(from, to);
      nativeWork.push(operation);
      h.track(operation);
      return operation;
    });
    let attempt: Promise<void> | undefined;
    try {
      attempt = h.start();
      await entered.promise;
      if (canceled) await h.cancel();
      release.resolve();
      await attempt;
      await h.drain();
      await Promise.all(nativeWork.map((p) => Promise.resolve(p).catch(() => undefined)));
      h.checkIdle();
      expect(commits).toHaveBeenCalledTimes(canceled ? 0 : 1);
      expect(h.callbacks).toHaveBeenCalledTimes(1);
      if (canceled) expect(h.callbacks.mock.calls[0][0]).toBeInstanceOf(UserCanceled);
      else expect(h.callbacks).toHaveBeenCalledExactlyOnceWith(null, "member");
      expect(h.cancellations).toHaveBeenCalledTimes(canceled ? 1 : 0);
      expect(h.installedEvent).toHaveBeenCalledTimes(canceled ? 0 : 1);
      expect(h.completion).toHaveBeenCalledTimes(canceled ? 0 : 1);
      expect(fs.existsSync(path.join(h.staging, "member.installing"))).toBe(false);
      expect(fs.existsSync(path.join(h.staging, "member"))).toBe(!canceled);
      if (!canceled) {
        expect(fs.readFileSync(path.join(h.staging, "member/selected.cfg"), "utf8")).toBe(
          "custom generated contents",
        );
        expect(fs.readFileSync(path.join(h.staging, "member/untouched.cfg"), "utf8")).toBe(
          h.payload,
        );
        expect(h.getState().persistent.profiles[h.profile.id].modState.member.enabled).toBe(true);
      } else {
        expect(h.getState().persistent.mods[h.game].member).toBeUndefined();
        expect(h.getState().persistent.profiles[h.profile.id].modState.member?.enabled).not.toBe(
          true,
        );
      }
      expect(fs.readFileSync(h.archive)).toEqual(h.archiveBefore);
      expect(h.errorNotifications).toEqual([]);
    } finally {
      release.resolve();
      await attempt?.catch(() => undefined);
      await h.drain();
      await Promise.all(nativeWork.map((p) => Promise.resolve(p).catch(() => undefined)));
      await h.cleanup();
    }
  });
}
