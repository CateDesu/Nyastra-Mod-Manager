import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

for (const owner of ["ordinary", "undefined"]) {
  for (const cancel of [false, true]) {
    test(`collection teardown preserves a queued independent install: owner=${owner}, cancel=${cancel}`, async ({
      makeInstallManager,
    }) => {
      const archiveRoot = await mkdtemp(path.join(tmpdir(), "vortex-cancel-install-"));
      const sourceId = owner === "undefined" ? "undefined" : `queued-source-${cancel}`;
      const profile = makeProfile({ id: `queued-cancel-profile-${cancel}` });
      const rule = makeRule({
        type: "requires",
        reference: { tag: `queued-dep-${cancel}`, gameId: "skyrimse" },
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
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const starts: string[] = [];
      h.api.emitAndAwait = (async (event, ...args) => {
        if (event === "will-install-mod") {
          starts.push(String(args[2]));
          await gate;
          throw new UserCanceled(true);
        }
        return [];
      }) as typeof h.api.emitAndAwait;
      const internals = managerInternals(h.manager);
      const callbacks: ReturnType<typeof vi.fn>[] = [];
      const done: Promise<void>[] = [];
      const install = (name: string) => {
        const callback = vi.fn();
        callbacks.push(callback);
        const completed = new Promise<void>((resolve) =>
          h.manager.install(
            null,
            path.join(archiveRoot, `${name}.zip`),
            ["skyrimse"],
            h.api,
            {},
            false,
            false,
            (...args) => {
              callback(...args);
              resolve();
            },
            "skyrimse",
          ),
        );
        done.push(completed);
        return completed;
      };
      const archive = path.join(archiveRoot, `independent-${cancel}-5.zip`);
      await writeFile(archive, "queued independent archive bytes");
      for (let index = 0; index < 6; index++) install(`independent-${cancel}-${index}`);
      let dependent: Promise<void> | undefined;
      let resumeQueue: (() => void) | undefined;
      try {
        await vi.waitFor(() => expect(starts).toHaveLength(5));
        dependent = h.manager.installDependencies(
          h.api,
          profile,
          "skyrimse",
          sourceId,
          true,
          false,
        );
        await vi.waitFor(() =>
          expect(
            h.manager.isInstallationActive(internals.generateDependencyInstallKey(sourceId, "dep")),
          ).toBe(true),
        );
        await vi.waitFor(() => expect(typeof internals.mInstallLimit.mNext).toBe("function"));
        resumeQueue = internals.mInstallLimit.mNext;
        if (cancel) await h.emitAndAwait("cancel-dependency-install", sourceId);
        release();
        await Promise.all(done.slice(0, 5));
        await install(`sentinel-${cancel}`);
        if (!cancel) await done[5];
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await readFile(archive, "utf8")).toBe("queued independent archive bytes");
        expect(callbacks[5]).toHaveBeenCalledTimes(1);
        expect(starts).toContain(`independent-${cancel}-5`);
        expect(
          h.manager
            .getActiveInstallations()
            .filter((active) => active.archivePath.includes(`independent-${cancel}-5`)),
        ).toEqual([]);
      } finally {
        release();
        if (cancel && callbacks[5].mock.calls.length === 0) resumeQueue?.();
        await Promise.all(done);
        await dependent;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(callbacks.every((cb) => cb.mock.calls.length === 1)).toBe(true);
        expect(h.manager.getActiveInstallations()).toEqual([]);
        expect(await readFile(archive, "utf8")).toBe("queued independent archive bytes");
        await rm(archiveRoot, { recursive: true, force: true });
      }
    });
  }
}
