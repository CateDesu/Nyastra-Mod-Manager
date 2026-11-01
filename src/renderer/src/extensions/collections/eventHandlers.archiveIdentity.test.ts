import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AlreadyDownloaded } from "@vortex/shared/errors";
import Bluebird from "bluebird";
import Zip from "node-7z";
import { afterEach, expect, vi } from "vitest";

import {
  makeApiHarness,
  makeDownload,
  makeGameStored,
  makeMod,
  makeProfile,
  managerInternals,
  registerHarnessGame,
} from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import { downloadPathForGame } from "../../util/selectors";
import { setDownloadPath } from "../download_management/actions/settings";
import { setCompatibleGames } from "../download_management/actions/state";
import { settingsReducer } from "../download_management/reducers/settings";
import * as downloadSelectors from "../download_management/selectors";
import setDownloadGames from "../download_management/util/setDownloadGames";
import { getGame } from "../gamemode_management/util/getGame";
import { onRemoveMods, onStartInstallDownload } from "../mod_management/eventHandlers";
import InstallManager from "../mod_management/InstallManager";
import { profilesReducer } from "../profile_management/reducers/profiles";
import { onCollectionUpdate } from "./eventHandlers";
import InstallDriver from "./util/InstallDriver";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

const GAME = "skyrimse";
const OTHER_GAME = "fallout4";
const MOVED_GAME = "witcher3";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
};

async function makeInstaller(root: string, enable: boolean, sharedDirectory: boolean) {
  registerHarnessGame(GAME);
  registerHarnessGame(OTHER_GAME);
  registerHarnessGame(MOVED_GAME);
  if (sharedDirectory) {
    const originalPath = downloadSelectors.downloadPathForGame;
    vi.spyOn(downloadSelectors, "downloadPathForGame").mockImplementation((state, game) =>
      game === GAME || game === MOVED_GAME
        ? path.join(root, "shared-downloads")
        : originalPath(state, game),
    );
  }
  const target = makeProfile({ id: "original", gameId: GAME });
  const last = makeProfile({ id: "last", gameId: GAME });
  const other = makeProfile({ id: "other", gameId: OTHER_GAME });
  const h = makeApiHarness(
    {
      knownGames: [
        makeGameStored({ id: GAME }),
        makeGameStored({ id: OTHER_GAME }),
        makeGameStored({ id: MOVED_GAME }),
      ],
      profiles: { original: target, last, other },
      activeProfileId: target.id,
      mods: { [GAME]: {}, [OTHER_GAME]: {}, [MOVED_GAME]: {} },
    },
    [
      { path: ["persistent", "profiles"], reducer: profilesReducer },
      { path: ["settings", "downloads"], reducer: settingsReducer },
    ],
  );
  h.setState((state) => {
    state.settings.downloads.path = path.join(root, "downloads");
    state.session.mods = {
      changes: [],
      updatingMods: {},
      deploymentProblems: [],
      deploymentFailures: {},
    };
    state.settings.profiles.lastActiveProfile[GAME] = last.id;
    state.settings.automation = {
      deploy: false,
      install: false,
      enable,
      start: false,
      minimized: false,
    };
    state.settings.mods.activator[GAME] = "empty";
    state.settings.mods.installPath[GAME] = path.join(root, "staging", GAME);
  });
  const directory = downloadPathForGame(h.getState(), GAME);
  fs.mkdirSync(directory, { recursive: true });
  const payload = path.join(root, "payload.txt");
  fs.writeFileSync(payload, "original profile payload");
  const manifest = path.join(root, "collection.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      info: {
        author: "Curator",
        authorUrl: "https://example.invalid/curator",
        name: "Collection A",
        description: "A collection",
        installInstructions: "",
        domainName: "skyrimspecialedition",
      },
      mods: [],
      modRules: [],
    }),
  );
  const archive = path.join(directory, "revision.zip");
  await new Zip().add(archive, [payload, manifest]);
  const bytes = fs.readFileSync(archive);
  h.setState((state) => {
    state.persistent.downloads.files.revision = makeDownload({
      id: "revision",
      localPath: "revision.zip",
      state: "finished",
      game: [GAME],
      size: bytes.length,
      fileMD5: "0123456789abcdef0123456789abcdef",
    });
  });
  const work: PromiseLike<unknown>[] = [];
  const track = <T extends PromiseLike<unknown>>(promise: T): T => {
    work.push(promise);
    void Promise.resolve(promise).catch(() => undefined);
    return promise;
  };
  const drain = async () => {
    for (const operation of manager["mRunningInstalls"].values()) void track(operation);
    for (const limiter of [internal.mInstallLimit, internal.mDependencyPipelineLimit]) {
      void track(limiter["mEndOfQueue"]);
    }
    let seen = -1;
    while (seen !== work.length) {
      seen = work.length;
      const outcomes = await Promise.all(
        work.map((item) =>
          Promise.resolve(item).then(
            () => ({ ok: true }),
            (error) => ({ ok: false, error }),
          ),
        ),
      );
      expect.soft(outcomes.filter((item) => !item.ok)).toEqual([]);
    }
    expect(manager["mRunningInstalls"].size).toBe(0);
    expect(internal.mPendingInstalls.size).toBe(0);
    expect(internal.mInstallLimit.mNext).toBeUndefined();
    expect(internal.mDependencyPipelineLimit.mNext).toBeUndefined();
    expect(manager.getActiveInstallations()).toEqual([]);
  };
  h.api.lookupModMeta = vi.fn<typeof h.api.lookupModMeta>().mockResolvedValue([]);
  h.api.lookupModReference = vi.fn<typeof h.api.lookupModReference>().mockResolvedValue([]);
  h.api.withPrePost =
    <T, A extends readonly unknown[]>(_name: string, callback: (...args: A) => PromiseLike<T>) =>
    (...args: A) =>
      Promise.resolve(track(callback(...args)));
  const manager = new InstallManager(h.api, (game) => path.join(root, "staging", game));
  manager.addInstaller(
    "copy",
    1,
    async () => ({ supported: true, requiredFiles: [] }),
    async () => ({
      instructions: [
        { type: "copy", source: "payload.txt", destination: "payload.txt" },
        { type: "copy", source: "collection.json", destination: "collection.json" },
        { type: "setmodtype", value: "collection" },
      ],
    }),
  );
  const internal = managerInternals(manager);
  const initialLimits = [internal.mInstallLimit.mLimit, internal.mDependencyPipelineLimit.mLimit];
  const install = internal.mInstallLimit.do.bind(internal.mInstallLimit);
  vi.spyOn(internal.mInstallLimit, "do").mockImplementation((fn) => track(install(fn)));
  const dependency = internal.mDependencyPipelineLimit.do.bind(internal.mDependencyPipelineLimit);
  vi.spyOn(internal.mDependencyPipelineLimit, "do").mockImplementation((fn) =>
    track(dependency(fn)),
  );
  const size = internal.setModSize.bind(manager);
  vi.spyOn(internal, "setModSize").mockImplementation((...args) => track(size(...args)));
  return { h, manager, target, last, other, drain, track, archive, bytes, internal, initialLimits };
}

for (const scenario of [
  "plain",
  "collision",
  "legacy",
  "legacy-alias",
  "stale-id",
  "legacy-other-only",
  "retired-row",
  "relocated-row",
  "relocated-shared-directory",
  "changed-directory",
  "alias-row",
] as const) {
  test(`cached collection update preserves archive identity: ${scenario}`, async () => {
    await import("../mod_management/index.js");
    const collision = scenario !== "plain";
    const relocated = scenario === "relocated-row" || scenario === "relocated-shared-directory";
    const changedDirectory = scenario === "changed-directory";
    const reviewed = relocated || changedDirectory || scenario === "alias-row";
    const unavailable =
      scenario === "stale-id" ||
      scenario === "legacy-other-only" ||
      scenario === "retired-row" ||
      relocated ||
      changedDirectory;
    expect(globalThis.Promise).toBe(Bluebird);
    const root = makeRoot("collection-identity-");
    const { h, manager, target, drain, track, archive, bytes, internal, initialLimits } =
      await makeInstaller(root, true, scenario === "relocated-shared-directory");
    getGame(GAME).getModPaths = () => ({});
    getGame(OTHER_GAME).getModPaths = () => ({});
    const archiveName = "Collection A-rev2.7z";
    let desired = path.join(path.dirname(archive), archiveName);
    fs.renameSync(archive, desired);
    const otherDirectory = downloadPathForGame(h.getState(), OTHER_GAME);
    fs.mkdirSync(otherDirectory, { recursive: true });
    const otherPayload = path.join(root, "other-payload", "payload.txt");
    fs.mkdirSync(path.dirname(otherPayload), { recursive: true });
    fs.writeFileSync(otherPayload, "unrelated other game payload");
    const otherManifest = path.join(path.dirname(otherPayload), "collection.json");
    fs.writeFileSync(
      otherManifest,
      JSON.stringify({
        info: {
          author: "Curator",
          authorUrl: "https://example.invalid",
          name: "Unrelated B",
          description: "Other game",
          installInstructions: "",
          domainName: OTHER_GAME,
        },
        mods: [],
        modRules: [],
      }),
    );
    const otherArchive = path.join(otherDirectory, archiveName);
    await new Zip().add(otherArchive, [otherPayload, otherManifest]);
    const otherBytes = fs.readFileSync(otherArchive);
    const oldId = "old-collection";
    const oldFile = path.join(root, "staging", GAME, oldId, "settings.ini");
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, "old collection user settings");
    h.setState((state) => {
      const current = {
        ...state.persistent.downloads.files.revision,
        localPath: archiveName,
        game: scenario === "legacy-alias" ? ["skyrimspecialedition"] : [GAME],
      };
      const unrelated = makeDownload({
        id: "unrelated",
        localPath: archiveName,
        state: "finished",
        game: [OTHER_GAME],
        size: otherBytes.length,
        fileMD5: "fedcba9876543210fedcba9876543210",
      });
      state.persistent.downloads.files =
        scenario === "legacy-other-only"
          ? { unrelated }
          : collision
            ? { unrelated, revision: current }
            : { revision: current };
      state.persistent.mods[GAME][oldId] = makeMod({
        id: oldId,
        type: "collection",
        installationPath: oldId,
        rules: reviewed ? [{ type: "requires", reference: { tag: "obsolete" } }] : [],
        attributes: { collectionSlug: "slug-a" },
      });
      if (reviewed) {
        state.persistent.mods[GAME].obsolete = makeMod({
          id: "obsolete",
          attributes: { referenceTag: "obsolete", installedAsDependency: true },
        });
      }
    });
    const emit = h.api.emitAndAwait.bind(h.api);
    h.api.emitAndAwait = (async (event, ...args) => {
      if (event === "get-nexus-collection-revision")
        return [
          {
            id: 2,
            revisionNumber: 2,
            downloadLink: "https://example.invalid/revision",
            collection: { id: 42, slug: "slug-a", name: "Collection A" },
          },
        ];
      if (event === "resolve-collection-url")
        return [[{ URI: "https://example.invalid/revision.7z" }]];
      return track(emit(event, ...args));
    }) as typeof h.api.emitAndAwait;
    const returnedId = scenario.startsWith("legacy")
      ? undefined
      : scenario === "stale-id"
        ? "gone"
        : "revision";
    const extract = Zip.prototype.extractFull;
    let collectionExtractions = 0;
    vi.spyOn(Zip.prototype, "extractFull").mockImplementation(function (...args) {
      const original: ReturnType<typeof extract> = track(extract.apply(this, args));
      void track(
        original.then((result) => {
          if (args[1].endsWith("collection-update-" + oldId)) ++collectionExtractions;
          if (scenario === "retired-row" && args[1].endsWith("collection-update-" + oldId)) {
            h.setState((state) => {
              delete state.persistent.downloads.files.revision;
            });
          }
          return result;
        }),
      );
      return original;
    });
    const review = deferred();
    const resume = deferred();
    if (reviewed) {
      h.api.showDialog = vi.fn<typeof h.api.showDialog>().mockImplementation((_type, title) => {
        expect(title).toBe("Remove mods from old revision?");
        review.resolve();
        return track(
          Bluebird.resolve(resume.promise).then(() => ({ action: "Keep All", input: {} })),
        );
      });
    }
    const already = new AlreadyDownloaded(archiveName, returnedId);
    const downloaded =
      vi.fn<(name: string, redownload: string, options: unknown, id: string | undefined) => void>();
    h.api.events.on("start-download", (_urls, _info, name, callback, redownload, options) => {
      downloaded(name, redownload, options, already.downloadId);
      callback(already);
    });
    const removed = vi.fn<(game: string, ids: string[]) => void>();
    h.api.events.on("remove-mods", (game, ids, callback, options) => {
      removed(game, ids);
      onRemoveMods(
        h.api,
        [{ id: "empty" }] as Parameters<typeof onRemoveMods>[1],
        manager,
        game,
        ids,
        callback,
        options,
      );
    });
    const installRequests = vi.fn<(id: string, options: unknown) => void>();
    const installed = vi.fn<(error: Error | null, modId: string | undefined) => void>();
    h.api.events.on("start-install-download", (id, options, callback) => {
      installRequests(id, options);
      void track(
        onStartInstallDownload(h.api, manager, id, options, (error, mod) => {
          installed(error, mod);
          callback(error, mod);
        }),
      );
    });
    const driver = new InstallDriver(h.api);
    let operation: PromiseLike<unknown> | undefined;
    const prepare = driver.prepare.bind(driver);
    vi.spyOn(driver, "prepare").mockImplementation((fn) =>
      prepare(() => {
        operation = fn();
        return operation;
      }),
    );
    const done = deferred();
    const completed = vi.fn<(error: Error | null) => void>(() => done.resolve());
    try {
      onCollectionUpdate(h.api, driver)(GAME, "slug-a", 2, "nexus", oldId, completed);
      if (reviewed) {
        await review.promise;
        expect(collectionExtractions).toBe(1);
        expect(removed).not.toHaveBeenCalled();
        if (relocated) {
          const previous = desired;
          await track(
            setDownloadGames(h.api, "revision", [MOVED_GAME], (_name, action) => action()),
          );
          desired = path.join(downloadPathForGame(h.getState(), MOVED_GAME), archiveName);
          expect(h.getState().persistent.downloads.files.revision).toMatchObject({
            id: "revision",
            localPath: archiveName,
            game: [MOVED_GAME],
          });
          expect(fs.existsSync(previous)).toBe(scenario === "relocated-shared-directory");
          expect(desired === previous).toBe(scenario === "relocated-shared-directory");
          expect(fs.readFileSync(desired)).toEqual(bytes);
        } else if (changedDirectory) {
          const previous = desired;
          const nextRoot = path.join(root, "moved-downloads");
          const nextDirectory = path.join(nextRoot, GAME);
          await track(fs.promises.mkdir(nextRoot, { recursive: true }));
          await track(fs.promises.rename(path.dirname(previous), nextDirectory));
          h.api.store.dispatch(setDownloadPath(nextRoot));
          desired = path.join(downloadPathForGame(h.getState(), GAME), archiveName);
          expect(desired).toBe(path.join(nextDirectory, archiveName));
          expect(fs.existsSync(previous)).toBe(false);
          expect(h.getState().persistent.downloads.files.revision.game).toEqual([GAME]);
          expect(fs.readFileSync(desired)).toEqual(bytes);
        } else {
          h.api.store.dispatch(setCompatibleGames("revision", ["skyrimspecialedition"]));
          expect(h.getState().persistent.downloads.files.revision.game).toEqual([
            "skyrimspecialedition",
          ]);
        }
        resume.resolve();
      }
      await done.promise;
      await operation;
      await drain();
      const [error, modId] = installed.mock.calls[0] ?? [];
      const output =
        typeof modId === "string"
          ? path.join(root, "staging", GAME, modId, "payload.txt")
          : undefined;
      expect
        .soft(downloaded)
        .toHaveBeenCalledExactlyOnceWith(archiveName, "never", { allowInstall: false }, returnedId);
      if (unavailable) {
        expect(installRequests).not.toHaveBeenCalled();
        expect(installed).not.toHaveBeenCalled();
        expect(removed).not.toHaveBeenCalled();
        expect(completed).toHaveBeenCalledExactlyOnceWith(null);
        expect(h.errorNotifications).toHaveLength(1);
        expect(fs.readFileSync(oldFile, "utf8")).toBe("old collection user settings");
        expect(h.getState().persistent.mods[GAME][oldId]).toMatchObject({
          id: oldId,
          type: "collection",
        });
      } else {
        expect
          .soft(installRequests)
          .toHaveBeenCalledExactlyOnceWith("revision", { profileId: target.id });
        expect.soft(installed).toHaveBeenCalledTimes(1);
        expect.soft(error).toBeNull();
        expect
          .soft(output && fs.existsSync(output) ? fs.readFileSync(output, "utf8") : undefined)
          .toBe("original profile payload");
        expect.soft(completed).toHaveBeenCalledExactlyOnceWith(null);
        expect.soft(h.errorNotifications).toEqual([]);
        expect(removed).toHaveBeenCalledExactlyOnceWith(GAME, [oldId]);
        expect(fs.existsSync(oldFile)).toBe(false);
        expect(h.getState().persistent.mods[GAME][oldId]).toBeUndefined();
      }
      expect(fs.readFileSync(desired)).toEqual(bytes);
      expect(fs.readFileSync(otherArchive)).toEqual(otherBytes);
      expect(manager.getActiveInstallations()).toEqual([]);
    } finally {
      resume.resolve();
      await operation;
      await drain();
      expect(internal.mInstallLimit.mLimit).toBe(initialLimits[0]);
      expect(internal.mDependencyPipelineLimit.mLimit).toBe(initialLimits[1]);
    }
  });
}
