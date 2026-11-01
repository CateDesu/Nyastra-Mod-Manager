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
import { downloadPathForGame } from "../../util/selectors";
import { profilesReducer } from "../profile_management/reducers/profiles";
import InstallManager from "./InstallManager";

afterEach(() => vi.restoreAllMocks());

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
type Entry = "required" | "recommended" | "required-event" | "recommended-event";

async function fixture(entry: Entry, installed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-attempt-owner-"));
  const game = "skyrimse";
  const recommended = entry.startsWith("recommended");
  registerHarnessGame(game);
  const a = makeProfile({ id: "attempt-a", gameId: game });
  const b = makeProfile({ id: "attempt-b", gameId: game });
  const rule = makeRule({
    type: recommended ? "recommends" : "requires",
    reference: { tag: "attempt-member", gameId: game },
  });
  const h = makeApiHarness(
    {
      knownGames: [makeGameStored()],
      profiles: { [a.id]: a, [b.id]: b },
      activeProfileId: a.id,
      mods: {
        [game]: {
          source: makeMod({ id: "source", type: "collection", rules: [rule] }),
          other: makeMod({ id: "other", rules: [] }),
          ...(installed
            ? {
                member: makeMod({
                  id: "member",
                  state: "installed",
                  archiveId: "archive",
                  attributes: { referenceTag: "attempt-member" },
                }),
              }
            : {}),
        },
      },
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
  const payload = path.join(root, "payload.txt");
  fs.writeFileSync(payload, "real payload from dependency lookup");
  const archive = path.join(directory, "member.zip");
  await new Zip().add(archive, [payload]);
  const archiveBefore = fs.readFileSync(archive);
  h.setState((state) => {
    state.persistent.downloads.files.archive = makeDownload({
      id: "archive",
      state: "finished",
      size: archiveBefore.length,
      fileMD5: "0123456789abcdef0123456789abcdef",
      game: [game],
      localPath: "member.zip",
      modInfo: { referenceTag: "attempt-member" },
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
  h.api.lookupModMeta = () => PromiseBB.resolve([]);
  h.api.lookupModReference = () => PromiseBB.resolve([]);
  vi.spyOn(notifications, "showDialog").mockImplementation(
    (_type, title) => () =>
      PromiseBB.resolve({
        action: title === "Install Recommendations" ? "Install All" : "Install",
        input: {},
      }),
  );
  const manager = new InstallManager(h.api, () => staging);
  manager.addInstaller(
    "attempt-copy",
    1,
    async () => ({ supported: true, requiredFiles: [] }),
    async () => ({
      instructions: [{ type: "copy", source: "payload.txt", destination: "payload.txt" }],
    }),
  );
  const i = managerInternals(manager);
  let queued = 0;
  for (const limiter of [i.mInstallLimit, i.mDependencyPipelineLimit]) {
    const original = limiter.do.bind(limiter);
    vi.spyOn(limiter, "do").mockImplementation((fn) => {
      if (limiter === i.mDependencyPipelineLimit) queued++;
      return track(original(fn));
    });
  }
  const size = i.setModSize.bind(manager);
  vi.spyOn(i, "setModSize").mockImplementation((...args) => track(size(...args)));
  const attempts: Promise<void>[] = [];
  const start = (profile = a, source = "source") => {
    const promise = entry.endsWith("event")
      ? h.emitAndAwait(
          "install-from-dependencies",
          source,
          source === "source" ? [rule] : [],
          recommended,
          profile.id,
        )
      : recommended
        ? manager.installRecommendations(h.api, profile, game, source)
        : manager.installDependencies(h.api, profile, game, source, true, false);
    attempts.push(promise);
    return promise;
  };
  const drain = async () => {
    let n = -1;
    while (n !== work.length) {
      n = work.length;
      await Promise.allSettled(work);
      await tick();
    }
  };
  const readInstalled = () =>
    Object.values(h.getState().persistent.mods[game]).filter(
      (mod) => !["source", "other"].includes(mod.id) && mod.state === "installed",
    );
  const checkPayload = (count: number, profile = a) => {
    const mods = readInstalled();
    expect(
      mods.map((mod) =>
        fs.readFileSync(path.join(staging, mod.installationPath, "payload.txt"), "utf8"),
      ),
    ).toEqual(Array.from({ length: count }, () => "real payload from dependency lookup"));
    expect(
      mods.map((mod) => h.getState().persistent.profiles[profile.id].modState[mod.id]?.enabled),
    ).toEqual(Array.from({ length: count }, () => true));
    expect(fs.readFileSync(archive)).toEqual(archiveBefore);
    expect(h.errorNotifications).toEqual([]);
  };
  const cleanup = async () => {
    await h.emitAndAwait("cancel-dependency-install", "source");
    await h.emitAndAwait("cancel-dependency-install", "other");
    await Promise.allSettled(attempts);
    await drain();
    expect(manager.getActiveInstallations()).toEqual([]);
    expect(i.mPendingInstalls.size).toBe(0);
    expect(i.mInstallLimit.mLimit).toBe(5);
    expect(i.mDependencyPipelineLimit.mLimit).toBe(10);
    fs.rmSync(root, { recursive: true, force: true });
  };
  return {
    ...h,
    manager,
    i,
    a,
    b,
    game,
    rule,
    start,
    drain,
    checkPayload,
    cleanup,
    queued: () => queued,
  };
}

for (const entry of ["required", "recommended", "required-event", "recommended-event"] as const) {
  for (const cancel of [false, true]) {
    test(`lookup cancellation controls real ZIP installation: ${entry}, cancel=${cancel}`, async () => {
      const h = await fixture(entry);
      const entered = deferred();
      const release = deferred();
      h.api.lookupModReference = () => {
        entered.resolve();
        return PromiseBB.resolve(release.promise).then(() => []);
      };
      const attempt = h.start();
      try {
        await entered.promise;
        expect(h.queued()).toBe(0);
        if (cancel) await h.emitAndAwait("cancel-dependency-install", "source");
        release.resolve();
        await attempt;
        await h.drain();
        h.checkPayload(cancel ? 0 : 1);
      } finally {
        release.resolve();
        await h.cleanup();
      }
    });
  }

  test(`late lookup cannot adopt or clean up the immediate retry: ${entry}`, async () => {
    const h = await fixture(entry);
    const entered = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    let calls = 0;
    h.api.lookupModReference = () => {
      const index = calls++;
      entered[index].resolve();
      return PromiseBB.resolve(release[index].promise).then(() => []);
    };
    const original = h.start();
    try {
      await entered[0].promise;
      const oldCancel = h.i.mDependencyInstalls.source;
      await h.emitAndAwait("cancel-dependency-install", "source");
      const retry = h.start(h.b);
      await entered[1].promise;
      const retryCancel = h.i.mDependencyInstalls.source;
      expect(retryCancel).toBeTypeOf("function");
      expect(retryCancel).not.toBe(oldCancel);
      release[0].resolve();
      await original;
      await h.drain();
      oldCancel?.();
      expect(h.i.mDependencyInstalls.source).toBe(retryCancel);
      expect(h.queued()).toBe(0);
      h.checkPayload(0);
      release[1].resolve();
      await retry;
      await h.drain();
      h.checkPayload(1, h.b);
      const mods = Object.values(h.getState().persistent.mods[h.game]).filter(
        (mod) => mod.id !== "source" && mod.id !== "other",
      );
      expect(
        mods.map(
          (mod) => h.getState().persistent.profiles[h.a.id].modState[mod.id]?.enabled ?? false,
        ),
      ).toEqual([false]);
    } finally {
      release.forEach((gate) => gate.resolve());
      await h.cleanup();
    }
  });
}

for (const mode of ["unchanged", "switch-only", "same-owner", "other-owner"] as const) {
  test(`direct and queued reuse retain the original profile: ${mode}`, async () => {
    const h = await fixture("required", true);
    const entered = deferred();
    const release = deferred();
    h.api.lookupModReference = () => {
      entered.resolve();
      return PromiseBB.resolve(release.promise).then(() => []);
    };
    const original = h.start();
    try {
      await entered.promise;
      if (mode !== "unchanged") {
        h.setState((state) => {
          state.settings.profiles.activeProfileId = h.b.id;
          state.settings.profiles.nextProfileId = h.b.id;
        });
      }
      if (mode === "same-owner" || mode === "other-owner")
        await h.start(mode === "same-owner" ? h.a : h.b, "other");
      release.resolve();
      await original;
      await h.drain();
      const profiles = h.getState().persistent.profiles;
      expect({
        a: profiles[h.a.id].modState.member?.enabled ?? false,
        b: profiles[h.b.id].modState.member?.enabled ?? false,
      }).toEqual({ a: true, b: false });
      expect(h.queued()).toBeGreaterThan(0);
      expect(h.errorNotifications).toEqual([]);
    } finally {
      release.resolve();
      await h.cleanup();
    }
  });
}

for (const entry of ["recommended", "required-event", "recommended-event"] as const) {
  test(`overlapping distinct owners keep profile writes through reuse: ${entry}`, async () => {
    const h = await fixture(entry, true);
    const entered = deferred();
    const release = deferred();
    h.api.lookupModReference = () => {
      entered.resolve();
      return PromiseBB.resolve(release.promise).then(() => []);
    };
    const original = h.start();
    try {
      await entered.promise;
      h.setState((state) => {
        state.settings.profiles.activeProfileId = h.b.id;
      });
      await h.start(h.b, "other");
      release.resolve();
      await original;
      await h.drain();
      const profiles = h.getState().persistent.profiles;
      expect({
        a: profiles[h.a.id].modState.member?.enabled ?? false,
        b: profiles[h.b.id].modState.member?.enabled ?? false,
      }).toEqual({ a: true, b: false });
      expect(h.queued()).toBeGreaterThan(0);
    } finally {
      release.resolve();
      await h.cleanup();
    }
  });
}

for (const entry of ["required", "recommended"] as const) {
  test(`cancellation is owned before asynchronous rule augmentation: ${entry}`, async () => {
    const h = await fixture(entry);
    const entered = deferred();
    const release = deferred();
    vi.spyOn(h.i, "augmentRules").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return [h.rule];
    });
    const lookup = vi.spyOn(h.api, "lookupModReference");
    const attempt = h.start();
    try {
      await entered.promise;
      await h.emitAndAwait("cancel-dependency-install", "source");
      release.resolve();
      await attempt;
      await h.drain();
      expect(lookup).not.toHaveBeenCalled();
      h.checkPayload(0);
    } finally {
      release.resolve();
      await h.cleanup();
    }
  });
}

for (const entry of ["required", "recommended"] as const) {
  for (const cancel of [false, true]) {
    test(`confirmation keeps its attempt owner: ${entry}, cancel=${cancel}`, async () => {
      const h = await fixture(entry);
      const entered = deferred();
      const release = deferred();
      vi.mocked(notifications.showDialog).mockImplementation((_type, title) => () => {
        entered.resolve();
        return PromiseBB.resolve(release.promise).then(() => ({
          action: title === "Install Recommendations" ? "Install All" : "Install",
          input: {},
        }));
      });
      // Required dependencies normally use silent mode in this fixture.
      const attempt =
        entry === "required"
          ? h.manager.installDependencies(h.api, h.a, h.game, "source", false, false)
          : h.start();
      try {
        await entered.promise;
        if (cancel) await h.emitAndAwait("cancel-dependency-install", "source");
        release.resolve();
        await attempt;
        await h.drain();
        h.checkPayload(cancel ? 0 : 1);
      } finally {
        release.resolve();
        await attempt;
        await h.cleanup();
      }
    });
  }
}

for (const entry of ["required", "recommended"] as const) {
  test(`two outstanding dependency operations keep distinct owners: ${entry}`, async () => {
    const h = await fixture(entry, true);
    const secondRule = makeRule({
      type: h.rule.type,
      reference: { tag: "second-member", gameId: h.game },
    });
    h.setState((state) => {
      state.persistent.mods[h.game].other.rules = [secondRule];
      state.persistent.mods[h.game].second = makeMod({
        id: "second",
        state: "installed",
        archiveId: "secondArchive",
        attributes: { referenceTag: "second-member" },
      });
      state.persistent.downloads.files.secondArchive = makeDownload({
        ...state.persistent.downloads.files.archive,
        id: "secondArchive",
        modInfo: { referenceTag: "second-member" },
      });
    });
    const entered = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    h.api.lookupModReference = (ref) => {
      const index = ref.tag === "attempt-member" ? 0 : 1;
      entered[index].resolve();
      return PromiseBB.resolve(release[index].promise).then(() => []);
    };
    const original = h.start();
    try {
      await entered[0].promise;
      const second = h.start(h.b, "other");
      await entered[1].promise;
      release[1].resolve();
      await second;
      release[0].resolve();
      await original;
      await h.drain();
      const profiles = h.getState().persistent.profiles;
      expect({
        a: [
          profiles[h.a.id].modState.member?.enabled ?? false,
          profiles[h.a.id].modState.second?.enabled ?? false,
        ],
        b: [
          profiles[h.b.id].modState.member?.enabled ?? false,
          profiles[h.b.id].modState.second?.enabled ?? false,
        ],
      }).toEqual({ a: [true, false], b: [false, true] });
      expect(h.queued()).toBeGreaterThanOrEqual(2);
    } finally {
      release.forEach((gate) => gate.resolve());
      await h.cleanup();
    }
  });
}

test("an owner moved to another game receives no dependency enable writes", async () => {
  const h = await fixture("required", true);
  const entered = deferred();
  const release = deferred();
  h.api.lookupModReference = () => {
    entered.resolve();
    return PromiseBB.resolve(release.promise).then(() => []);
  };
  const attempt = h.start();
  try {
    await entered.promise;
    h.setState((state) => {
      state.persistent.profiles[h.a.id].gameId = "fallout4";
      state.settings.profiles.activeProfileId = h.b.id;
    });
    release.resolve();
    await attempt;
    await h.drain();
    const profiles = h.getState().persistent.profiles;
    expect([
      profiles[h.a.id].modState.member?.enabled ?? false,
      profiles[h.b.id].modState.member?.enabled ?? false,
    ]).toEqual([false, false]);
    expect(h.queued()).toBeGreaterThan(0);
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

for (const entry of ["required", "recommended", "required-event", "recommended-event"] as const) {
  test(`real ZIP install options and background enabling retain the owner: ${entry}`, async () => {
    const h = await fixture(entry);
    const entered = deferred();
    const release = deferred();
    h.api.lookupModReference = () => {
      entered.resolve();
      return PromiseBB.resolve(release.promise).then(() => []);
    };
    const install = h.manager.install.bind(h.manager);
    const installCalls = vi.spyOn(h.manager, "install").mockImplementation((...args) => {
      expect(args[4].profileId).toBe(h.a.id);
      return install(...args);
    });
    const attempt = h.start();
    try {
      await entered.promise;
      h.setState((state) => {
        state.settings.profiles.activeProfileId = h.b.id;
      });
      await h.start(h.b, "other");
      release.resolve();
      await attempt;
      await h.drain();
      h.checkPayload(1);
      expect(installCalls).toHaveBeenCalledTimes(1);
      const installedId = Object.values(h.getState().persistent.mods[h.game]).find(
        (mod) => !["source", "other"].includes(mod.id),
      )?.id;
      expect(h.getState().persistent.profiles[h.b.id].modState[installedId]?.enabled ?? false).toBe(
        false,
      );
    } finally {
      release.resolve();
      await h.cleanup();
    }
  });
}

for (const failure of [false, true]) {
  test(`late phase deployment cannot start or clean up retry tasks: failure=${failure}`, async () => {
    const h = await fixture("required");
    const entered = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    let calls = 0;
    h.api.lookupModReference = () => {
      const index = calls++;
      entered[index].resolve();
      return PromiseBB.resolve(release[index].promise).then(() => []);
    };
    const deployment = deferred();
    let finishDeployment!: (error?: Error) => void;
    const deploy = (callback: (error?: Error) => void) => {
      finishDeployment = callback;
      deployment.resolve();
    };
    h.api.events.on("deploy-mods", deploy);
    const original = h.start();
    let poll: Promise<void> | undefined;
    try {
      await entered[0].promise;
      const phase = h.i.mPhaseTracker.ensure("source");
      phase.allowedPhase = 0;
      phase.deploymentPromises.set(0, {
        deploymentPromise: Promise.resolve(),
        deployOnSettle: true,
      });
      poll = h.manager.pollPhaseSettlement(h.api, "source", { phase: 0 });
      await deployment.promise;
      await h.emitAndAwait("cancel-dependency-install", "source");
      h.start(h.b);
      await entered[1].promise;
      const retryPhase = h.i.mPhaseTracker.ensure("source");
      const retryCancel = h.i.mDependencyInstalls.source;
      const retryTask = vi.fn();
      retryPhase.pendingByPhase.set(0, [retryTask]);
      finishDeployment(failure ? new Error("retired deployment failed") : undefined);
      await poll;
      await h.drain();
      expect(retryTask).not.toHaveBeenCalled();
      expect(h.i.mPhaseTracker.get("source")).toBe(retryPhase);
      expect(h.i.mDependencyInstalls.source).toBe(retryCancel);
      expect(retryPhase.pendingByPhase.get(0)).toEqual([retryTask]);
    } finally {
      h.api.events.removeListener("deploy-mods", deploy);
      finishDeployment?.();
      release.forEach((gate) => gate.resolve());
      await original;
      await poll;
      await h.cleanup();
    }
  });
}
