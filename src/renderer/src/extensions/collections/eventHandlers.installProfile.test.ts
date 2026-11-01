import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
import { getGame } from "../gamemode_management/util/getGame";
import { onRemoveMods, onStartInstallDownload } from "../mod_management/eventHandlers";
import InstallManager from "../mod_management/InstallManager";
import { setCurrentProfile, setNextProfile } from "../profile_management/actions/settings";
import { profilesReducer } from "../profile_management/reducers/profiles";
import { settingsReducer as profileSettings } from "../profile_management/reducers/settings";
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
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
};

async function makeInstaller(root: string, enable: boolean) {
  registerHarnessGame(GAME);
  registerHarnessGame(OTHER_GAME);
  const target = makeProfile({ id: "original", gameId: GAME });
  const last = makeProfile({ id: "last", gameId: GAME });
  const other = makeProfile({ id: "other", gameId: OTHER_GAME });
  const h = makeApiHarness(
    {
      knownGames: [makeGameStored({ id: GAME }), makeGameStored({ id: OTHER_GAME })],
      profiles: { original: target, last, other },
      activeProfileId: target.id,
      mods: { [GAME]: {}, [OTHER_GAME]: {} },
    },
    [
      { path: ["persistent", "profiles"], reducer: profilesReducer },
      { path: ["settings", "profiles"], reducer: profileSettings },
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
    let seen = -1;
    while (seen !== work.length) {
      seen = work.length;
      await Promise.allSettled(work);
    }
  };
  h.api.lookupModMeta = vi.fn().mockResolvedValue([]);
  h.api.lookupModReference = vi.fn().mockResolvedValue([]);
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
  const install = internal.mInstallLimit.do.bind(internal.mInstallLimit);
  vi.spyOn(internal.mInstallLimit, "do").mockImplementation((fn) => track(install(fn)));
  const size = internal.setModSize.bind(manager);
  vi.spyOn(internal, "setModSize").mockImplementation((...args) => track(size(...args)));
  return { h, manager, target, last, other, drain, track, archive, bytes };
}

test("collection replacement enables the captured profile after switching profiles and games", async () => {
  const root = makeRoot("vortex-collection-profile-");
  const { h, manager, target, last, other, drain, track, archive, bytes } = await makeInstaller(
    root,
    true,
  );
  getGame(GAME).getModPaths = () => ({});
  const oldId = "old-collection";
  const oldFile = path.join(root, "staging", GAME, oldId, "settings.ini");
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, "old collection settings");
  h.setState((state) => {
    state.persistent.mods[GAME][oldId] = makeMod({
      id: oldId,
      type: "collection",
      installationPath: oldId,
      rules: [],
      attributes: { collectionSlug: "slug-a" },
    });
  });
  const entered = deferred();
  const release = deferred();
  const emit = h.api.emitAndAwait.bind(h.api);
  h.api.emitAndAwait = (async (event, ...args) => {
    if (event === "get-nexus-collection-revision") {
      entered.resolve();
      await release.promise;
      return [
        {
          id: 2,
          revisionNumber: 2,
          downloadLink: "https://example.invalid/revision",
          collection: { id: 42, slug: "slug-a", name: "Collection A" },
        },
      ];
    }
    if (event === "resolve-collection-url")
      return [[{ URI: "https://example.invalid/revision.zip" }]];
    return track(emit(event, ...args));
  }) as typeof h.api.emitAndAwait;
  h.api.events.on("start-download", (_urls, _info, _name, callback) => callback(null, "revision"));
  h.api.events.on("remove-mods", (game, ids, callback, options) =>
    onRemoveMods(
      h.api,
      [{ id: "empty" }] as Parameters<typeof onRemoveMods>[1],
      manager,
      game,
      ids,
      callback,
      options,
    ),
  );
  const installed = vi.fn();
  h.api.events.on("start-install-download", (id, options, callback) => {
    track(
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
  const completed = vi.fn();
  try {
    onCollectionUpdate(h.api, driver)(GAME, "slug-a", 2, "nexus", oldId, completed);
    await entered.promise;
    h.api.store.dispatch(setCurrentProfile(other.gameId, other.id));
    h.api.store.dispatch(setNextProfile(other.id));
    release.resolve();
    await operation;
    await drain();

    expect(completed).toHaveBeenCalledExactlyOnceWith(null);
    expect(installed).toHaveBeenCalledTimes(1);
    const [error, modId] = installed.mock.calls[0];
    expect(error).toBeNull();
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(h.getState().persistent.mods[GAME][oldId]).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "staging", GAME, modId, "payload.txt"), "utf8")).toBe(
      "original profile payload",
    );
    expect(h.getState().persistent.profiles[target.id].modState[modId]?.enabled).toBe(true);
    expect(h.getState().persistent.profiles[last.id].modState[modId]?.enabled).not.toBe(true);
    expect(h.getState().persistent.profiles[other.id].modState[modId]?.enabled).not.toBe(true);
    expect(fs.readFileSync(archive)).toEqual(bytes);
    expect(h.errorNotifications).toEqual([]);
  } finally {
    release.resolve();
    await operation;
    await drain();
    expect(manager.getActiveInstallations()).toEqual([]);
  }
});

for (const profileId of ["missing", "other", "original", undefined]) {
  test(`installation resolves its target profile: ${profileId ?? "default"}`, async () => {
    const root = makeRoot("vortex-install-profile-");
    const { h, manager, drain, archive, bytes } = await makeInstaller(root, false);
    const callback = vi.fn();
    try {
      const result = new Promise<unknown>((resolve) => {
        void onStartInstallDownload(h.api, manager, "revision", { profileId }, (error, id) => {
          callback(error, id);
          resolve(error);
        });
      });
      const error = await result;
      await drain();
      expect(callback).toHaveBeenCalledTimes(1);
      if (profileId === "missing" || profileId === "other") {
        expect(error).toBeInstanceOf(Error);
        expect(h.getState().persistent.mods[GAME]).toEqual({});
      } else {
        expect(error).toBeNull();
        const modId = callback.mock.calls[0][1];
        expect(h.getState().persistent.mods[GAME][modId]).toBeDefined();
        expect(
          fs.readFileSync(path.join(root, "staging", GAME, modId, "payload.txt"), "utf8"),
        ).toBe("original profile payload");
      }
      expect(fs.readFileSync(archive)).toEqual(bytes);
    } finally {
      await drain();
      expect(manager.getActiveInstallations()).toEqual([]);
    }
  });
}
