import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import PromiseBB from "bluebird";
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
import * as fs from "../../util/fs";
import { downloadPathForGame } from "../download_management/selectors";

afterEach(() => vi.restoreAllMocks());
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tick = () => new Promise<void>((r) => setImmediate(r));

for (const location of ["converted", "fallback"]) {
  for (const timing of ["control", "cancel", "retry"]) {
    test(`archive lookup cannot outlive its cancelled attempt: ${location}/${timing}`, async ({
      makeInstallManager,
    }) => {
      const sourceId = `cancel-lookup-${location}-${timing}`;
      const profile = makeProfile({ id: `${sourceId}-profile` });
      const rule = makeRule({
        type: "requires",
        reference: { tag: `${sourceId}-dep`, gameId: "skyrimse" },
      });
      const h = makeInstallManager({
        knownGames: [makeGameStored()],
        profiles: { [profile.id]: profile },
        activeProfileId: profile.id,
        mods: {
          skyrimse: { [sourceId]: makeMod({ id: sourceId, type: "collection", rules: [rule] }) },
        },
        downloads: {
          dep: makeDownload({
            id: "dep",
            game: ["skyrimspecialedition"],
            state: "finished",
            size: 100,
            localPath: `${sourceId}.zip`,
            modInfo: { referenceTag: rule.reference.tag },
          }),
        },
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
      const archiveRoot = await mkdtemp(path.join(tmpdir(), "vortex-cancel-lookup-"));
      h.setState((state) => {
        state.settings.downloads.path = archiveRoot;
      });
      const archive = path.join(
        downloadPathForGame(
          h.getState(),
          location === "fallback" ? "skyrimspecialedition" : "skyrimse",
        ),
        `${sourceId}.zip`,
      );
      await mkdir(path.dirname(archive), { recursive: true });
      await writeFile(archive, "actual archive identity fixture");
      const statGate = deferred();
      const hookGate = deferred();
      const lateGate = deferred();
      let heldStat = false;
      let statReleased = false;
      const originalStat = fs.statAsync;
      vi.spyOn(fs, "statAsync").mockImplementation((filename) => {
        if (filename === archive && !heldStat) {
          heldStat = true;
          return PromiseBB.resolve(statGate.promise).then(() => {
            statReleased = true;
            return originalStat(filename);
          });
        }
        return originalStat(filename);
      });
      const starts: unknown[] = [];
      h.api.emitAndAwait = (async (event, ...args) => {
        if (event === "will-install-mod") {
          starts.push(args[1]);
          await (timing === "retry" && starts.length === 2 ? lateGate.promise : hookGate.promise);
          throw new UserCanceled(true);
        }
        return [];
      }) as typeof h.api.emitAndAwait;
      const internals = managerInternals(h.manager);
      const work: Array<{ kind: string; p: Promise<unknown> }> = [];
      for (const [kind, limiter] of [
        ["inner", internals.mInstallLimit],
        ["outer", internals.mDependencyPipelineLimit],
      ] as const) {
        const original = limiter.do.bind(limiter) as typeof limiter.do;
        vi.spyOn(limiter, "do").mockImplementation(<T>(cb: () => PromiseLike<T>) => {
          const p = original<T>(cb);
          work.push({ kind, p });
          void p.catch(() => undefined);
          return p;
        });
      }
      const callbackCalls: number[] = [];
      const originalInstall = h.manager.install.bind(h.manager) as typeof h.manager.install;
      vi.spyOn(h.manager, "install").mockImplementation(
        (...args: Parameters<typeof h.manager.install>) => {
          const index = callbackCalls.length;
          callbackCalls.push(0);
          const callback = args[7];
          args[7] = (...cbArgs: Parameters<typeof callback>) => {
            callbackCalls[index]++;
            callback(...cbArgs);
          };
          return originalInstall(...args);
        },
      );
      const attempts: Promise<void>[] = [];
      let retryTracking: ReturnType<typeof h.manager.getActiveInstallation>;
      let retryPhase: ReturnType<typeof h.phaseTracker.get>;
      let firstPhase: ReturnType<typeof h.phaseTracker.get>;
      try {
        attempts.push(
          h.manager.installDependencies(h.api, profile, "skyrimse", sourceId, true, false),
        );
        await vi.waitFor(() => expect(heldStat).toBe(true));
        firstPhase = h.phaseTracker.get(sourceId);
        expect(starts).toEqual([]);
        if (timing !== "control") {
          await h.emitAndAwait("cancel-dependency-install", sourceId);
          await attempts[0];
        }
        if (timing === "retry") {
          attempts.push(
            h.manager.installDependencies(h.api, profile, "skyrimse", sourceId, true, false),
          );
          await vi.waitFor(() => expect(starts).toEqual(["dep"]));
          retryTracking = h.manager.getActiveInstallation(
            internals.generateDependencyInstallKey(sourceId, "dep"),
          );
          retryPhase = h.phaseTracker.get(sourceId);
          expect(retryTracking).toBeDefined();
        }
        statGate.resolve();
        if (timing === "retry") lateGate.resolve();
        else hookGate.resolve();
        const originalOuter = work.find((w) => w.kind === "outer");
        if (originalOuter === undefined) throw new Error("Missing dependency operation");
        await originalOuter.p;
        expect(statReleased).toBe(true);
        expect(starts).toEqual(timing === "cancel" ? [] : ["dep"]);
        if (timing === "retry")
          expect(
            h.manager.getActiveInstallation(
              internals.generateDependencyInstallKey(sourceId, "dep"),
            ),
          ).toBe(retryTracking);
      } finally {
        statGate.resolve();
        hookGate.resolve();
        lateGate.resolve();
        await h.emitAndAwait("cancel-dependency-install", sourceId);
        await Promise.all(attempts);
        let count = -1;
        for (let i = 0; i < 20 && count !== work.length; i++) {
          count = work.length;
          await Promise.allSettled(work.map((w) => w.p));
        }
        await tick();
        expect(count).toBe(work.length);
        expect(callbackCalls.every((n) => n === 1)).toBe(true);
        expect(internals.mInstallLimit.mLimit).toBe(5);
        expect(internals.mDependencyPipelineLimit.mLimit).toBe(10);
        expect(internals.mPendingInstalls.size).toBe(0);
        expect(h.manager.getActiveInstallations()).toEqual([]);
        expect(firstPhase?.activeByPhase.get(0)).toBe(0);
        if (retryPhase) expect(retryPhase.activeByPhase.get(0)).toBe(0);
        await rm(archiveRoot, { recursive: true, force: true });
      }
      expect(starts).toEqual(timing === "cancel" ? [] : ["dep"]);
      expect(callbackCalls).toEqual(timing === "cancel" ? [] : [1]);
    });
  }
}
