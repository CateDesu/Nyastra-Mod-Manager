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

for (const overlap of ["distinct", "hyphen", "colon"])
  test(`collection cancel settles its outer queued jobs and preserves an unrelated dependency pipeline: overlap=${overlap}`, async ({
    makeInstallManager,
  }) => {
    const sourceId = `cancel-owner-source-${overlap}`;
    const otherId =
      overlap === "distinct"
        ? `cancel-other-source-${overlap}`
        : `${sourceId}${overlap === "colon" ? ":" : "-"}extras`;
    const profile = makeProfile({ id: "cancel-owner-profile" });
    const rules = Array.from({ length: 12 }, (_, i) =>
      makeRule({ type: "requires", reference: { tag: `cancel-owner-${i}`, gameId: "skyrimse" } }),
    );
    const otherRule = makeRule({
      type: "requires",
      reference: { tag: "cancel-other", gameId: "skyrimse" },
    });
    const downloads = Object.fromEntries(
      [...rules, otherRule].map((rule, i) => {
        const id = i === 12 ? "other" : `dep-${i}`;
        return [
          id,
          makeDownload({
            id,
            game: ["skyrimse"],
            state: "finished",
            size: 100,
            localPath: `${id}.zip`,
            modInfo: { referenceTag: rule.reference.tag },
          }),
        ];
      }),
    );
    const h = makeInstallManager({
      knownGames: [makeGameStored()],
      profiles: { [profile.id]: profile },
      activeProfileId: profile.id,
      mods: {
        skyrimse: {
          [sourceId]: makeMod({ id: sourceId, type: "collection", rules }),
          [otherId]: makeMod({ id: otherId, rules: [otherRule] }),
        },
      },
      downloads,
      session: makeInstallState({
        activeSession: makeSession({
          sessionId: generateCollectionSessionId(sourceId, profile.id),
          collectionId: sourceId,
          profileId: profile.id,
          gameId: "skyrimse",
          totalRequired: 12,
          downloadedCount: 12,
          mods: Object.fromEntries(
            rules.map((rule) => [
              modRuleId(rule),
              makeModInstallInfo({ rule, type: "requires", status: "downloaded", phase: 0 }),
            ]),
          ),
        }),
      }),
    });
    Object.assign(h.api, { lookupModReference: async () => [], lookupModMeta: async () => [] });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const starts: unknown[] = [];
    h.api.emitAndAwait = (async (event, ...args) => {
      if (event === "will-install-mod") {
        starts.push(args[1]);
        if (args[1] === null) await gate;
        throw new UserCanceled(true);
      }
      return [];
    }) as typeof h.api.emitAndAwait;
    const internals = managerInternals(h.manager);
    const work: Promise<unknown>[] = [];
    let pipelineSubmitted = 0;
    let installSubmitted = 0;
    for (const limiter of [internals.mInstallLimit, internals.mDependencyPipelineLimit]) {
      const original = limiter.do.bind(limiter) as typeof limiter.do;
      vi.spyOn(limiter, "do").mockImplementation(<T>(cb: () => PromiseLike<T>) => {
        if (limiter === internals.mDependencyPipelineLimit) pipelineSubmitted++;
        else installSubmitted++;
        const p = original<T>(cb);
        work.push(p);
        void p.catch(() => undefined);
        return p;
      });
    }
    const callbacks = Array.from({ length: 5 }, () => vi.fn());
    const direct = callbacks.map(
      (cb, i) =>
        new Promise<void>((resolve) =>
          h.manager.install(
            null,
            path.join(tmpdir(), `cancel-pipeline-blocker-${i}.zip`),
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
    let resume: (() => void) | undefined;
    try {
      await vi.waitFor(() => expect(starts).toHaveLength(5));
      attempts.push(
        h.manager.installDependencies(h.api, profile, "skyrimse", sourceId, true, false),
      );
      await vi.waitFor(() => expect(pipelineSubmitted).toBe(12));
      expect(installSubmitted).toBe(15);
      attempts.push(
        h.manager.installDependencies(h.api, profile, "skyrimse", otherId, true, false),
      );
      await vi.waitFor(() => expect(pipelineSubmitted).toBe(13));
      await vi.waitFor(() =>
        expect(typeof internals.mDependencyPipelineLimit.mNext).toBe("function"),
      );
      resume = internals.mDependencyPipelineLimit.mNext;
      const otherWasPending = internals.mPendingInstalls.has(
        internals.generateDependencyInstallKey(otherId, "other"),
      );
      expect(otherWasPending).toBe(true);
      await h.emitAndAwait("cancel-dependency-install", sourceId);
      const otherPendingAfterCancel = internals.mPendingInstalls.has(
        internals.generateDependencyInstallKey(otherId, "other"),
      );
      expect(otherPendingAfterCancel).toBe(true);
      release();
      await Promise.all(direct);
      await new Promise<void>((r) => setImmediate(r));
      expect(starts.filter((id) => id !== null)).toEqual(["other"]);
    } finally {
      release();
      if (!starts.includes("other")) resume?.();
      await h.emitAndAwait("cancel-dependency-install", sourceId);
      await h.emitAndAwait("cancel-dependency-install", otherId);
      await Promise.all(direct);
      await Promise.all(attempts);
      let n = -1;
      while (n !== work.length) {
        n = work.length;
        await Promise.allSettled(work);
      }
      expect(callbacks.map((cb) => cb.mock.calls.length)).toEqual([1, 1, 1, 1, 1]);
      expect(h.manager.getActiveInstallations()).toEqual([]);
      expect(internals.mPendingInstalls.size).toBe(0);
      expect(internals.mInstallLimit.mLimit).toBe(5);
      expect(internals.mDependencyPipelineLimit.mLimit).toBe(10);
    }
  });
