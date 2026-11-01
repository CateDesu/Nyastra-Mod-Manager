import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, vi } from "vitest";

import {
  makeMod,
  makeProfile,
  makeRule,
  makeDownload,
  makeGameStored,
  makeInstallState,
  makeSession,
  makeModInstallInfo,
  managerInternals,
} from "../../test-utils/builders";
import { test } from "../../test-utils/installManagerTest";
import { generateCollectionSessionId, modRuleId } from "../../util/collectionInstallSession";
import { UserCanceled } from "../../util/CustomErrors";

afterEach(() => vi.restoreAllMocks());
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
};

for (const installWhileDownloading of [false, true])
  for (const mode of ["live", "cancelled"] as const) {
    test(`a late bundled import cannot launch cancelled installation: ${mode}, installWhileDownloading=${installWhileDownloading}`, async ({
      makeInstallManager,
    }) => {
      const detached: Promise<unknown>[] = [];
      const race = Promise.race.bind(Promise);
      vi.spyOn(Promise, "race").mockImplementation(<T>(values: Iterable<T | PromiseLike<T>>) => {
        const items = Array.from(values);
        if (items.length === 2) detached.push(Promise.resolve(items[0]));
        return race(items);
      });
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-cancel-import-"));
      const profile = makeProfile({ id: "p" });
      const sourceId = "collection-import";
      const rule = makeRule({
        type: "requires",
        reference: { tag: "bundle-import", gameId: "skyrimse" },
        extra: { localPath: "bundled/bundle.7z" },
      });
      const source = makeMod({
        id: sourceId,
        type: "collection",
        installationPath: "collection-import",
        rules: [rule],
      });
      const h = makeInstallManager({
        knownGames: [makeGameStored()],
        activeProfileId: profile.id,
        profiles: { [profile.id]: profile },
        mods: { skyrimse: { [sourceId]: source } },
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
      h.setState((d) => {
        d.settings.downloads.path = path.join(root, "downloads");
        d.settings.downloads.collectionsInstallWhileDownloading = installWhileDownloading;
        d.settings.mods.installPath.skyrimse = path.join(root, "staging");
      });
      Object.assign(h.api, { lookupModReference: async () => [], lookupModMeta: async () => [] });
      const i = managerInternals(h.manager);
      const importStarted = deferred();
      const hookGate = deferred();
      const importCallbacks: Array<(ids: string[]) => void> = [];
      h.api.events.on("import-downloads", (_paths, cb) => {
        importCallbacks.push(cb);
        importStarted.resolve();
      });
      const starts: Array<{ archive: unknown; mod: unknown }> = [];
      const work: Promise<unknown>[] = [];
      h.api.emitAndAwait = (async (event, ...args) => {
        if (event === "will-install-mod") {
          starts.push({ archive: args[1], mod: args[2] });
          await hookGate.promise;
          throw new UserCanceled(true);
        }
        return [];
      }) as typeof h.api.emitAndAwait;
      for (const limiter of [i.mInstallLimit, i.mDependencyPipelineLimit]) {
        const original = limiter.do.bind(limiter) as typeof limiter.do;
        vi.spyOn(limiter, "do").mockImplementation(<T>(cb: () => PromiseLike<T>) => {
          const p = original<T>(cb);
          work.push(p);
          void p.catch(() => undefined);
          return p;
        });
      }
      const attempts: Promise<unknown>[] = [];
      let importReleased = false;
      const releaseImport = () => {
        if (importReleased) return;
        importReleased = true;
        h.setState((d) => {
          d.persistent.downloads.files.bundle = makeDownload({
            id: "bundle",
            state: "finished",
            size: 100,
            game: ["skyrimse"],
            localPath: "bundle.7z",
          });
        });
        for (const cb of importCallbacks) cb(["bundle"]);
      };
      const drain = async () => {
        let seen = "";
        for (let turn = 0; turn < 20; turn++) {
          const all = [...work, ...detached];
          const signature = `${all.length}:${work.length}`;
          await Promise.allSettled(all);
          await new Promise<void>((r) => setImmediate(r));
          if (signature === seen) return;
          seen = signature;
        }
        throw Error("Audit drain did not stabilize");
      };
      try {
        attempts.push(
          h.manager.installDependencies(h.api, profile, "skyrimse", sourceId, true, false),
        );
        await importStarted.promise;
        expect(importCallbacks).toHaveLength(1);
        if (mode !== "live") {
          await h.emitAndAwait("cancel-dependency-install", sourceId);
          await attempts[0];
          expect(i.mDependencyInstalls[sourceId]).toBeUndefined();
        }
        releaseImport();
        await Promise.allSettled(detached);
        await new Promise<void>((r) => setImmediate(r));
        if (mode === "live") await vi.waitFor(() => expect(starts).toHaveLength(1));
        expect(starts).toHaveLength(mode === "live" ? 1 : 0);
        if (mode === "cancelled") expect(h.phaseTracker.get(sourceId)).toBeUndefined();
      } finally {
        releaseImport();
        hookGate.resolve();
        await h.emitAndAwait("cancel-dependency-install", sourceId);
        await Promise.allSettled(attempts);
        await drain();
        await h.emitAndAwait("cancel-dependency-install", sourceId);
        expect(h.manager.getActiveInstallations()).toEqual([]);
        expect(i.mInstallLimit.mLimit).toBe(5);
        expect(i.mDependencyPipelineLimit.mLimit).toBe(10);
        fs.rmSync(root, { recursive: true, force: true });
        expect(starts).toHaveLength(mode === "live" ? 1 : 0);
      }
    });
  }
