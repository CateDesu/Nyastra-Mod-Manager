import { tmpdir } from "node:os";
import path from "node:path";

import { expect, vi, afterEach } from "vitest";

import {
  managerInternals,
  makeProfile,
  makeMod,
  makeRule,
  makeDownload,
  makeGameStored,
  makeInstallState,
  makeSession,
  makeModInstallInfo,
} from "../../test-utils/builders";
import { test } from "../../test-utils/installManagerTest";
import { modRuleId, generateCollectionSessionId } from "../../util/collectionInstallSession";
import { UserCanceled } from "../../util/CustomErrors";

afterEach(() => vi.restoreAllMocks());
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

for (const timing of ["none", "immediate", "eager", "drained"]) {
  const retry = timing !== "none";
  test(`cancelled collection work cannot claim a later attempt: timing=${timing}`, async ({
    makeInstallManager,
  }) => {
    const sourceId = `cancel-retry-source-${timing}`;
    const profile = makeProfile({ id: `cancel-retry-profile-${timing}` });
    const rule = makeRule({
      type: "requires",
      reference: { tag: `cancel-retry-dep-${timing}`, gameId: "skyrimse" },
    });
    const source = makeMod({ id: sourceId, type: "collection", rules: [rule] });
    const download = makeDownload({
      id: "dep",
      game: ["skyrimse"],
      state: "finished",
      size: 100,
      localPath: "dep.zip",
      modInfo: { referenceTag: rule.reference.tag },
    });
    const h = makeInstallManager({
      knownGames: [makeGameStored()],
      profiles: { [profile.id]: profile },
      activeProfileId: profile.id,
      mods: { skyrimse: { [sourceId]: source } },
      downloads: { dep: download },
      session: makeInstallState({
        activeSession: makeSession({
          sessionId: generateCollectionSessionId(sourceId, profile.id),
          collectionId: sourceId,
          profileId: profile.id,
          gameId: "skyrimse",
          totalRequired: 1,
          downloadedCount: 1,
          mods: {
            [modRuleId(rule)]: makeModInstallInfo({
              rule,
              type: "requires",
              status: "downloaded",
              phase: 0,
            }),
          },
        }),
      }),
    });
    Object.assign(h.api, { lookupModReference: async () => [], lookupModMeta: async () => [] });
    const directGate = deferred();
    const depGate = deferred();
    const starts: Array<{ archive: unknown; mod: unknown }> = [];
    h.api.emitAndAwait = (async (event, ...args) => {
      if (event === "will-install-mod") {
        starts.push({ archive: args[1], mod: args[2] });
        await (args[1] === "dep" ? depGate.promise : directGate.promise);
        throw new UserCanceled(true);
      }
      return [];
    }) as typeof h.api.emitAndAwait;
    const internals = managerInternals(h.manager);
    const work: Promise<unknown>[] = [];
    let installsSubmitted = 0;
    for (const limiter of [internals.mInstallLimit, internals.mDependencyPipelineLimit]) {
      const original = limiter.do.bind(limiter) as typeof limiter.do;
      vi.spyOn(limiter, "do").mockImplementation(<T>(cb: () => PromiseLike<T>) => {
        if (limiter === internals.mInstallLimit) installsSubmitted++;
        const p = original<T>(cb);
        work.push(p);
        void p.catch(() => undefined);
        return p;
      });
    }
    const callbacks = Array.from({ length: 5 }, () => vi.fn());
    const direct = callbacks.map(
      (cb, index) =>
        new Promise<void>((resolve) =>
          h.manager.install(
            null,
            path.join(tmpdir(), `cancel-blocker-${index}.zip`),
            ["skyrimse"],
            h.api,
            {},
            false,
            false,
            (...args) => {
              cb(...args);
              resolve();
            },
            "skyrimse",
          ),
        ),
    );
    const attempts: Promise<void>[] = [];
    const oldPollTick = deferred();
    const oldPollGate = deferred();
    let oldSettled = false;
    const originalTimer = globalThis.setTimeout;
    let observingPoll = false;
    let firstPollTimer = true;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
      if (!observingPoll || delay !== 500 || !firstPollTimer) {
        return originalTimer(callback, delay, ...args);
      }
      firstPollTimer = false;
      return originalTimer(
        (...values) => {
          const run = () => {
            callback(...values);
            oldPollTick.resolve();
          };
          if (timing === "immediate") void oldPollGate.promise.then(run);
          else run();
        },
        delay,
        ...args,
      );
    }) as typeof globalThis.setTimeout);
    const poll = internals.pollAllPhasesComplete.bind(internals);
    vi.spyOn(internals, "pollAllPhasesComplete").mockImplementation((...args) => {
      observingPoll = true;
      try {
        return poll(...args);
      } finally {
        observingPoll = false;
      }
    });
    try {
      await vi.waitFor(() => expect(starts).toHaveLength(5));
      attempts.push(
        h.manager.installDependencies(h.api, profile, "skyrimse", sourceId, true, false),
      );
      void attempts[0].then(() => {
        oldSettled = true;
      });
      await vi.waitFor(() => expect(installsSubmitted).toBe(6));
      await vi.waitFor(() => expect(typeof internals.mInstallLimit.mNext).toBe("function"));
      await h.emitAndAwait("cancel-dependency-install", sourceId);
      if (timing !== "immediate") {
        await attempts[0];
        expect(internals.mDependencyInstalls[sourceId]).toBeUndefined();
      }
      if (timing === "drained") {
        directGate.resolve();
        await Promise.all(direct);
        let n = -1;
        while (n !== work.length) {
          n = work.length;
          await Promise.allSettled(work);
        }
        expect(starts.filter((s) => s.archive === "dep")).toHaveLength(0);
      }
      if (retry) {
        attempts.push(
          h.manager.installDependencies(h.api, profile, "skyrimse", sourceId, true, false),
        );
        await vi.waitFor(() => expect(installsSubmitted).toBe(7));
      }
      if (timing === "immediate") {
        const retryPhase = h.phaseTracker.get(sourceId);
        const retryCancel = internals.mDependencyInstalls[sourceId];
        expect(retryPhase).toBeDefined();
        expect(retryCancel).toBeDefined();
        oldPollGate.resolve();
        await oldPollTick.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(oldSettled).toBe(true);
        await attempts[0];
        expect(h.phaseTracker.get(sourceId)).toBe(retryPhase);
        expect(internals.mDependencyInstalls[sourceId]).toBe(retryCancel);
      }
      directGate.resolve();
      await Promise.all(direct);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (retry)
        await vi.waitFor(() =>
          expect(starts.filter((s) => s.archive === "dep").length).toBeGreaterThan(0),
        );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(starts.filter((s) => s.archive === "dep")).toHaveLength(retry ? 1 : 0);
    } finally {
      oldPollGate.resolve();
      directGate.resolve();
      depGate.resolve();
      await h.emitAndAwait("cancel-dependency-install", sourceId);
      await Promise.all(direct);
      await Promise.all(attempts);
      let n = -1;
      while (n !== work.length) {
        n = work.length;
        await Promise.allSettled(work);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(callbacks.map((cb) => cb.mock.calls.length)).toEqual([1, 1, 1, 1, 1]);
      expect(internals.mInstallLimit.mLimit).toBe(5);
      expect(internals.mDependencyPipelineLimit.mLimit).toBe(10);
      expect(h.manager.getActiveInstallations()).toEqual([]);
    }
  });
}
