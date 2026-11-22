import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import Bluebird from "bluebird";
import SevenZip from "node-7z";
import { afterEach, expect, test, vi } from "vitest";

import {
  makeApiHarness,
  makeDownload,
  makeGameStored,
  makeMod,
  makeProfile,
} from "../../test-utils/builders";
import { test as installManagerTest } from "../../test-utils/installManagerTest";
import type { IAvailableExtension } from "../../types/extensions";
import type { IExtensionApi, IExtensionContext } from "../../types/IExtensionContext";
import { relaunch } from "../../util/commandLine";
import { DataInvalid, ProcessCanceled, UserCanceled } from "../../util/CustomErrors";
import { fetchAvailableExtensions } from "../extension_manager/util";
import { getGame, getGameStubDownloadInfo } from "../gamemode_management/util/getGame";
import initProfiles from "../profile_management";
import { profilesReducer } from "../profile_management/reducers/profiles";
import { settingsReducer } from "../profile_management/reducers/settings";
import { onStartInstallDownload } from "./eventHandlers";
import type InstallManager from "./InstallManager";
import { ensureStagingDirectory } from "./stagingDirectory";
import type { IInstallOptions } from "./types/IInstallOptions";

vi.mock("../../util/commandLine", () => ({ relaunch: vi.fn() }));
vi.mock("../extension_manager/util", () => ({ fetchAvailableExtensions: vi.fn() }));
vi.mock("../gamemode_management/util/getGame", { spy: true });
vi.mock("./stagingDirectory", { spy: true });

const TARGET = "residentevil22019";
const ACTIVE = "skyrimse";
const ARCHIVE = "payload.zip";
const SUPPORT: IAvailableExtension = {
  name: "Resident Evil 2 Vortex Extension",
  type: "game",
  gameDomain: TARGET,
  modId: 1234,
  fileId: 5,
  author: "Author",
  version: "1.0.0",
  timestamp: 1,
};
const roots: string[] = [];

afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(game = [TARGET], catalog = [SUPPORT], startupGameId?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "nyastra-install-target-"));
  roots.push(root);
  const archive = path.join(root, game[0], ARCHIVE);
  await mkdir(path.dirname(archive));
  await writeFile(archive, "original archive");
  const download = makeDownload({
    state: "finished",
    game,
    localPath: ARCHIVE,
    modInfo: { source: "nexus", nexus: { ids: { gameId: game[0], modId: 7, fileId: 42 } } },
  });
  const h = makeApiHarness(
    {
      knownGames: [makeGameStored()],
      profiles: { other: makeProfile({ id: "other", gameId: ACTIVE }) },
      downloads: { [download.id]: download },
      discovered: { [ACTIVE]: { path: path.join(root, ACTIVE) } },
      availableExtensions: catalog,
    },
    [
      { path: ["persistent", "profiles"], reducer: profilesReducer },
      { path: ["settings", "profiles"], reducer: settingsReducer },
    ],
  );
  h.setState((state) => {
    state.session.base = {
      commandLine: { game: startupGameId && TARGET },
    } as typeof state.session.base;
    state.session.gameMode.disabled = {};
    state.settings.downloads.path = root;
    state.settings.automation = { enable: true } as typeof state.settings.automation;
    if (startupGameId !== undefined) {
      state.app = { extensions: {} } as typeof state.app;
      state.session.gameMode.known.push(
        makeGameStored({
          id: startupGameId,
          details: { nexusPageId: TARGET },
        }),
      );
      state.settings.gameMode.discovered[startupGameId] = { path: root };
    }
  });
  // Test Manage through its events while leaving the profile switch itself to its own suite.
  h.api.onStateChange = vi.fn();
  const emitAndAwait = vi.fn(async (event: string, ...args: unknown[]) =>
    Promise.all(h.api.events.listeners(event).map((listener) => listener(...args))),
  );
  h.api.emitAndAwait = emitAndAwait as IExtensionApi["emitAndAwait"];
  h.api.ext.ensureLoggedIn = vi.fn(() => Bluebird.resolve());
  const context: Partial<IExtensionContext> = { api: h.api, once: (callback) => void callback() };
  initProfiles(
    new Proxy(context, {
      get: (target, key) => Reflect.get(target, key) ?? (() => undefined),
    }) as IExtensionContext,
  );
  h.setState((state) => {
    state.settings.profiles.activeProfileId = "other";
    state.settings.profiles.nextProfileId = "other";
  });
  const install = vi.fn<InstallManager["install"]>();
  const callback = vi.fn();
  const start = (options: IInstallOptions = {}) =>
    onStartInstallDownload(
      h.api,
      { install } as unknown as InstallManager,
      download.id,
      options,
      callback,
    );
  const loadGame = (id = TARGET) =>
    h.setState((state) => {
      state.session.gameMode.known.push(makeGameStored({ id, details: { nexusPageId: game[0] } }));
    });
  const manageProfile = (gameId = TARGET) =>
    h.setState((state) => {
      state.persistent.profiles.target = makeProfile({ id: "target", gameId });
      state.settings.profiles.lastActiveProfile[gameId] = "target";
    });
  return {
    h,
    root,
    archive,
    download,
    emitAndAwait,
    install,
    callback,
    start,
    loadGame,
    manageProfile,
  };
}

test("uses the catalog provider when only a stub is loaded and retries the same archive after setup", async () => {
  const f = await fixture();
  vi.mocked(getGameStubDownloadInfo).mockReturnValue({ name: "Old RE2 support", modId: 432 });
  vi.mocked(getGame).mockReturnValue({ id: TARGET, name: "Resident Evil 2" } as ReturnType<
    typeof getGame
  >);
  // Discovery can outlive an extension. A stale path plus a stub is still missing support.
  f.h.setState((state) => {
    state.settings.gameMode.discovered[TARGET] = { path: f.root };
  });
  f.h.setNextDialog({ action: "Download", input: {} });
  f.h.api.onAsync("install-extension", async () => true);

  await f.start();

  expect(f.h.dialogCalls).toEqual([{ type: "question", title: "Game support not installed" }]);
  expect(f.emitAndAwait).toHaveBeenCalledWith("install-extension", SUPPORT);
  expect(relaunch).toHaveBeenCalledExactlyOnceWith(["--game", TARGET]);
  expect(f.install).not.toHaveBeenCalled();
  expect(f.callback).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled), undefined);
  expect(f.h.getState().persistent.downloads.files[f.download.id]).toEqual(f.download);
  expect(await readFile(f.archive, "utf8")).toBe("original archive");

  f.loadGame();
  f.manageProfile();
  await f.start();

  expect(f.install).toHaveBeenCalledTimes(1);
  expect(f.install.mock.calls[0][1]).toBe(f.archive);
  expect(f.install.mock.calls[0][8]).toBe(TARGET);
});

test.each(["Cancel", "Download"])(
  "keeps the archive when extension setup ends with %s",
  async (action) => {
    const f = await fixture();
    f.h.setNextDialog({ action, input: {} });
    const installExtension = vi.fn(async () => false);
    f.h.api.onAsync("install-extension", installExtension);

    await f.start();

    expect(installExtension).toHaveBeenCalledTimes(action === "Download" ? 1 : 0);
    expect(relaunch).not.toHaveBeenCalled();
    expect(f.install).not.toHaveBeenCalled();
    expect(f.callback).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled), undefined);
    expect(f.h.getState().persistent.downloads.files[f.download.id]).toEqual(f.download);
  },
);

test("reports when no matching game extension is available", async () => {
  const f = await fixture([TARGET], [{ ...SUPPORT, type: undefined }]);
  vi.mocked(fetchAvailableExtensions).mockResolvedValue([{ ...SUPPORT, gameDomain: ACTIVE }]);

  await f.start();

  expect(f.h.errorNotifications).toEqual([
    expect.objectContaining({ title: "Failed to manage game", allowReport: false }),
  ]);
  expect(f.h.dialogCalls).toEqual([]);
  expect(f.install).not.toHaveBeenCalled();
});

test("refreshes a catalog that is missing the current provider even if the stub has a file ID", async () => {
  const f = await fixture([TARGET], []);
  vi.mocked(getGameStubDownloadInfo).mockReturnValue({
    name: "Old support",
    modId: 432,
    fileId: 1,
  });
  vi.mocked(fetchAvailableExtensions).mockResolvedValue([SUPPORT]);
  f.h.setNextDialog({ action: "Download", input: {} });
  f.h.api.onAsync("install-extension", async () => true);

  await f.start();

  expect(fetchAvailableExtensions).toHaveBeenCalledWith(f.h.api, true);
  expect(f.emitAndAwait).toHaveBeenCalledWith("install-extension", SUPPORT);
  expect(relaunch).toHaveBeenCalledExactlyOnceWith(["--game", TARGET]);
});

test("finds a missing extension by its Nexus domain when the internal ID differs", async () => {
  const entry = { ...SUPPORT, gameDomain: "elderscrollsonline" };
  const f = await fixture(["teso"], [entry]);
  f.h.setNextDialog({ action: "Download", input: {} });
  f.h.api.onAsync("install-extension", async () => true);
  await f.start();
  expect(f.emitAndAwait).toHaveBeenCalledWith("install-extension", entry);
  expect(relaunch).toHaveBeenCalledExactlyOnceWith(["--game", entry.name]);
});

test("resolves the restart game by domain if the newly loaded extension uses a different ID", async () => {
  const realId = "re2-internal";
  vi.mocked(ensureStagingDirectory).mockResolvedValue("staging");
  const f = await fixture([TARGET], [SUPPORT], realId);

  await vi.waitFor(() => {
    const { settings, persistent } = f.h.getState();
    expect(persistent.profiles[settings.profiles.nextProfileId]?.gameId).toBe(realId);
  });
  expect(f.emitAndAwait).toHaveBeenCalledWith("discover-game", realId);
  expect(f.h.dialogCalls).toEqual([]);
  expect(f.install).not.toHaveBeenCalled();
});

test.each([false, true])(
  "uses Manage's discovery and folder prompt with a selected folder: %s",
  async (selected) => {
    const f = await fixture();
    f.loadGame();
    vi.mocked(ensureStagingDirectory).mockResolvedValue(path.join(f.root, "staging"));
    f.h.api.events.on("manually-set-game-location", (gameId, done) => {
      expect(gameId).toBe(TARGET);
      if (selected) {
        f.h.setState((state) => {
          state.settings.gameMode.discovered[TARGET] = { path: f.root };
        });
      }
      done(null);
    });

    await f.start();

    expect(f.emitAndAwait).toHaveBeenCalledWith("discover-game", TARGET);
    expect(f.h.dialogCalls).toEqual([{ type: "question", title: "Game not discovered" }]);
    const next = f.h.getState().settings.profiles.nextProfileId;
    expect(f.h.getState().persistent.profiles[next].gameId).toBe(selected ? TARGET : ACTIVE);
    expect(f.install).not.toHaveBeenCalled();
    expect(f.h.getState().persistent.downloads.files[f.download.id]).toEqual(f.download);
    if (selected) {
      expect(f.h.notifications).toContainEqual(
        expect.objectContaining({
          id: `ready-to-install-${f.download.id}`,
          replace: { archive: ARCHIVE },
          actions: [expect.objectContaining({ title: "Open Downloads" })],
        }),
      );
      f.h.setState((state) => {
        state.settings.profiles.activeProfileId = next;
        state.settings.profiles.lastActiveProfile[TARGET] = next;
      });
      await f.start();
      expect(f.install.mock.calls[0][8]).toBe(TARGET);
      expect(f.install.mock.calls[0][4].downloadProfileId).toBe(next);
    }
  },
);

test.each(["Cancel", "Manage"])(
  "offers setup for a discovered game without a usable profile: %s",
  async (action) => {
    const f = await fixture();
    f.loadGame();
    f.h.setState((state) => {
      state.settings.gameMode.discovered[TARGET] = { path: f.root };
      state.settings.profiles.lastActiveProfile[TARGET] = "other";
    });
    vi.mocked(ensureStagingDirectory).mockResolvedValue(f.root);
    f.h.setNextDialog({ action, input: {} });

    await f.start();

    expect(f.h.dialogCalls).toEqual([{ type: "question", title: "Manage game" }]);
    const state = f.h.getState();
    expect(state.persistent.profiles[state.settings.profiles.nextProfileId].gameId).toBe(
      action === "Manage" ? TARGET : ACTIVE,
    );
    expect(f.install).not.toHaveBeenCalled();
    expect(f.callback).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled), undefined);
  },
);

test("abandons first-time setup when the discovered location changes during staging", async () => {
  const f = await fixture();
  f.loadGame();
  f.h.setState((state) => {
    state.settings.gameMode.discovered[TARGET] = { path: f.root };
  });
  f.h.setNextDialog({ action: "Manage", input: {} });
  vi.mocked(ensureStagingDirectory).mockImplementationOnce(async () => {
    f.h.setState((state) => {
      delete state.settings.gameMode.discovered[TARGET];
    });
    return f.root;
  });

  await f.start();

  expect(f.h.getState().settings.profiles.nextProfileId).toBe("other");
  expect(Object.keys(f.h.getState().persistent.profiles)).toEqual(["other"]);
  expect(f.install).not.toHaveBeenCalled();
});

test("honors a game directory override before discovery or installation", async () => {
  const f = await fixture([ACTIVE]);
  f.h.setState((state) => {
    state.session.gameMode.disabled[ACTIVE] = TARGET;
  });

  await f.start();

  expect(f.h.dialogCalls).toEqual([{ type: "question", title: "Game disabled" }]);
  expect(f.emitAndAwait).not.toHaveBeenCalledWith("discover-game", ACTIVE);
  expect(f.install).not.toHaveBeenCalled();
});

test("rejects a replaced download with the same name, size and game", async () => {
  const f = await fixture([ACTIVE]);

  const pending = f.start();
  f.h.setState((state) => {
    state.persistent.downloads.files[f.download.id].modInfo.nexus.ids.fileId = 43;
  });
  await pending;

  expect(f.install).not.toHaveBeenCalled();
  expect(f.callback).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled), undefined);
});

test("honors a declared compatible active game while reading the original archive", async () => {
  const f = await fixture([TARGET, "skyrimspecialedition"]);
  await f.start();
  expect(f.emitAndAwait).not.toHaveBeenCalled();
  expect(f.install.mock.calls[0][1]).toBe(f.archive);
  expect(f.install.mock.calls[0][8]).toBe(ACTIVE);
});

test("honors compatibility added by a game extension after the archive was downloaded", async () => {
  const f = await fixture();
  f.h.setState((state) => {
    state.session.gameMode.known[0].details.compatibleDownloads = [TARGET];
  });

  await f.start();

  expect(f.emitAndAwait).not.toHaveBeenCalled();
  expect(f.install.mock.calls[0][1]).toBe(f.archive);
  expect(f.install.mock.calls[0][8]).toBe(ACTIVE);
});

test("keeps the intended profile when the active profile switches while checking the archive", async () => {
  const f = await fixture([ACTIVE]);

  const started = f.start();
  f.h.setState((state) => {
    state.persistent.profiles.second = makeProfile({ id: "second", gameId: ACTIVE });
    state.settings.profiles.activeProfileId = "second";
  });
  await started;

  expect(f.install).toHaveBeenCalledTimes(1);
  expect(f.install.mock.calls[0][4].downloadProfileId).toBe("other");
  const isCurrentAttempt = f.install.mock.calls[0][15];
  expect(isCurrentAttempt()).toBe(true);
  f.h.setState((state) => {
    state.persistent.profiles.other.pendingRemove = true;
  });
  expect(isCurrentAttempt()).toBe(false);
});

test("declines an explicit profile for a game that cannot use the archive", async () => {
  const f = await fixture();

  await f.start({ profileId: "other" });

  expect(f.callback).toHaveBeenCalledExactlyOnceWith(expect.any(ProcessCanceled), undefined);
  expect(f.emitAndAwait).not.toHaveBeenCalled();
  expect(f.install).not.toHaveBeenCalled();
});

test("cancels before setup if the download is removed during the archive check", async () => {
  const f = await fixture();

  const started = f.start();
  f.h.setState((state) => {
    delete state.persistent.downloads.files[f.download.id];
  });
  await started;

  expect(f.callback).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled), undefined);
  expect(f.emitAndAwait).not.toHaveBeenCalled();
  expect(f.install).not.toHaveBeenCalled();
});

test("settles the caller while requesting a refresh for an incomplete archive record", async () => {
  const f = await fixture();
  f.h.setState((state) => {
    delete state.persistent.downloads.files[f.download.id].localPath;
  });
  const refresh = vi.fn();
  f.h.api.events.on("refresh-downloads", refresh);

  await f.start();

  expect(refresh).toHaveBeenCalledExactlyOnceWith(TARGET, expect.any(Function));
  expect(f.callback).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled), undefined);
  expect(f.install).not.toHaveBeenCalled();
});

test("reads a pre-extension archive from its recorded domain after the internal ID becomes known", async () => {
  const f = await fixture();
  const internalId = "re2-internal";
  f.loadGame(internalId);
  f.manageProfile(internalId);
  f.h.setState((state) => {
    state.settings.gameMode.discovered[internalId] = { path: f.root };
  });
  await mkdir(path.join(f.root, internalId));
  await writeFile(path.join(f.root, internalId, ARCHIVE), "another archive with the same name");

  await f.start();

  expect(f.install.mock.calls[0][1]).toBe(f.archive);
  expect(f.install.mock.calls[0][8]).toBe(internalId);
});

test.each([undefined, "original-md5"])(
  "rejects an unverifiable alternate archive with recorded hash %s",
  async (hash) => {
    const f = await fixture();
    const internalId = "re2-internal";
    f.loadGame(internalId);
    f.manageProfile(internalId);
    f.h.setState((state) => {
      state.settings.gameMode.discovered[internalId] = { path: f.root };
      state.persistent.downloads.files[f.download.id].fileMD5 = hash;
    });
    await rm(f.archive);
    await mkdir(path.join(f.root, internalId));
    await writeFile(path.join(f.root, internalId, ARCHIVE), "another archive with the same name");

    await f.start();

    expect(f.install).not.toHaveBeenCalled();
    expect(f.callback).toHaveBeenCalledExactlyOnceWith(expect.any(DataInvalid), undefined);
  },
);

test("selects the matching archive when both game folders contain the filename", async () => {
  const f = await fixture();
  const id = "re2-internal";
  f.loadGame(id);
  f.manageProfile(id);
  f.h.setState((state) => {
    state.settings.gameMode.discovered[id] = { path: f.root };
    state.persistent.downloads.files[f.download.id].fileMD5 = "expected";
  });
  await mkdir(path.join(f.root, id));
  const alternate = path.join(f.root, id, ARCHIVE);
  await writeFile(alternate, "correct archive");
  f.h.api.genMd5Hash = (file) =>
    Bluebird.resolve({
      md5sum: file === alternate ? "expected" : "other",
      numBytes: 15,
    });

  await f.start();

  expect(f.install.mock.calls[0][1]).toBe(alternate);
  expect(f.install.mock.calls[0][8]).toBe(id);
});

test("keeps collection archives on their existing install path", async () => {
  const f = await fixture();
  f.h.setState((state) => {
    state.persistent.downloads.files[f.download.id].modInfo = { source: "nexus", collectionId: 42 };
  });

  await f.start();

  expect(f.emitAndAwait).not.toHaveBeenCalled();
  expect(f.install.mock.calls[0][1]).toBe(f.archive);
  expect(f.install.mock.calls[0][8]).toBe(TARGET);
});

test("installs a collection update for its requested compatible profile after switching games", async () => {
  const f = await fixture([TARGET]);
  const edition = "compatible-edition";
  f.manageProfile(edition);
  f.h.setState((state) => {
    state.session.gameMode.known.push(
      makeGameStored({ id: edition, details: { compatibleDownloads: [TARGET] } }),
    );
    state.persistent.downloads.files[f.download.id].modInfo = { source: "nexus", collectionId: 42 };
  });

  await f.start({ profileId: "target" });

  expect(f.emitAndAwait).not.toHaveBeenCalled();
  expect(f.install.mock.calls[0][1]).toBe(f.archive);
  expect(f.install.mock.calls[0][8]).toBe(edition);
  expect(f.install.mock.calls[0][4].profileId).toBe("target");
});

test("preserves the site download install path", async () => {
  const f = await fixture(["site"]);
  await f.start();
  expect(f.emitAndAwait).not.toHaveBeenCalled();
  expect(f.install.mock.calls[0][8]).toBe("site");
});

installManagerTest(
  "the installer rejects a missing forced game even if another game is active",
  async ({ makeInstallManager }) => {
    const f = await fixture();
    const { api, manager } = makeInstallManager({
      knownGames: [makeGameStored()],
      downloads: { [f.download.id]: f.download },
      activeProfileId: "other",
      profiles: { other: makeProfile({ id: "other", gameId: ACTIVE }) },
    });
    const hook = vi.spyOn(api, "emitAndAwait");
    const error = await new Promise<Error>((resolve) => {
      manager.install(
        f.download.id,
        f.archive,
        [TARGET],
        api,
        { download: f.download },
        true,
        true,
        resolve,
        TARGET,
      );
    });

    expect(error).toBeInstanceOf(ProcessCanceled);
    expect(error.message).toContain(TARGET);
    expect(hook.mock.calls.map(([event]) => event)).not.toContain("will-install-mod");
    expect(await readFile(f.archive, "utf8")).toBe("original archive");
  },
);

installManagerTest(
  "a variant reinstall after a profile switch only disables the original profile's variant",
  async ({ makeInstallManager }) => {
    const f = await fixture([ACTIVE]);
    const { manager } = makeInstallManager();
    const staging = path.join(f.root, "staging");
    manager["mGetInstallPath"] = () => staging;
    const payload = path.join(f.root, "payload.txt");
    await writeFile(payload, "installed variant");
    await rm(f.archive);
    await new SevenZip().add(f.archive, [payload]);
    f.h.setState((s) => {
      s.settings.mods.installPath[ACTIVE] = staging;
      s.persistent.mods[ACTIVE] = {
        original: makeMod({ id: "original", archiveId: f.download.id }),
      };
      s.persistent.profiles.unrelated = makeProfile({ id: "unrelated", gameId: TARGET });
      s.settings.profiles.activeProfileId = "unrelated";
      s.settings.profiles.lastActiveProfile[ACTIVE] = "other";
      s.persistent.profiles.other.modState.original = { enabled: true, enabledTime: 1 };
      s.persistent.profiles.second = makeProfile({
        id: "second",
        gameId: ACTIVE,
        modState: { original: { enabled: true, enabledTime: 1 } },
      });
    });
    f.h.api.withPrePost =
      (_name, callback) =>
      (...args) =>
        Promise.resolve(callback(...args));
    f.h.api.lookupModMeta = () => {
      f.h.setState((s) => {
        s.settings.profiles.activeProfileId = "second";
      });
      return Bluebird.resolve([]);
    };
    vi.spyOn(f.h.api, "showDialog")
      .mockResolvedValueOnce({ action: "Continue", input: { variant: true } })
      .mockResolvedValueOnce({ action: "Continue", input: { variant: "new" } });
    manager.addInstaller(
      "copy",
      0,
      async () => ({ supported: true, requiredFiles: [] }),
      async () => ({
        instructions: [{ type: "copy", source: "payload.txt", destination: "payload.txt" }],
      }),
    );

    const completed = vi.fn();
    f.h.api.events.on("did-install-mod", completed);
    await onStartInstallDownload(f.h.api, manager, f.download.id, {}, f.callback);
    await Promise.all(manager["mRunningInstalls"].values());

    expect(f.callback).toHaveBeenCalledExactlyOnceWith(null, "original+new");
    expect(completed.mock.calls[0][4]).toBe("other");
    expect(await readFile(path.join(staging, "original+new", "payload.txt"), "utf8")).toBe(
      "installed variant",
    );
    const profiles = f.h.getState().persistent.profiles;
    expect(profiles.other.modState.original.enabled).toBe(false);
    expect(profiles.second.modState.original.enabled).toBe(true);
    expect(profiles.other.modState["original+new"].enabled).toBe(true);
    expect(profiles.second.modState["original+new"]).toBeUndefined();
    expect(profiles.unrelated.modState["original+new"]).toBeUndefined();
    expect(f.h.getState().persistent.mods[TARGET]?.["original+new"]).toBeUndefined();
  },
);
