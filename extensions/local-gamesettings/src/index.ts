import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import * as path from "path";

import { actions, fs, log, selectors, type types, util } from "@nexusmods/vortex-api";
import PromiseBB from "bluebird";
import type * as Redux from "redux";

import {
  backupPath,
  gameSettingsFiles,
  gameSupported,
  initGameSupport,
  type ISettingsFile,
  mygamesPath,
  profilePath,
} from "./util/gameSupport";

function isMissingSource(source: string, error: { code?: string }): PromiseBB<boolean> {
  if (error.code !== "ENOENT") {
    return PromiseBB.resolve(false);
  }
  return fs
    .statAsync(source)
    .then(() => false)
    .catch({ code: "ENOENT" }, () => true);
}

function copyGameSettings(
  sourcePath: string,
  destinationPath: string,
  files: ISettingsFile[],
  copyType: string,
): PromiseBB<void> {
  let firstFailure: PromiseBB.Inspection<void> | undefined;
  return PromiseBB.map(files, (gameSetting) => {
    let source = path.join(sourcePath, gameSetting.name);
    let destination = path.join(destinationPath, path.basename(gameSetting.name));
    const destinationOrig = destination;

    if (copyType.startsWith("Glo")) {
      source += ".base";
    } else if (copyType.endsWith("Glo")) {
      destination += ".base";
    }

    log("debug", "copying profile inis", { source, destination });

    return fs
      .copyAsync(source, destination, { noSelfCopy: true })
      .catch((err) =>
        isMissingSource(source, err).then((missing) => {
          if (!missing) {
            return PromiseBB.reject(err);
          }
          if (gameSetting.optional) {
            const destinations = copyType.endsWith("Glo")
              ? [destination, destinationOrig, destinationOrig + ".baked"]
              : [destination];
            return PromiseBB.mapSeries(destinations, (file) =>
              fs.unlinkAsync(file).catch((error: NodeJS.ErrnoException) => {
                if (error?.code !== "ENOENT") throw error;
              }),
            ).then(() => undefined);
          }
          switch (copyType) {
            // Seed missing settings from the global file.
            case "BacGlo":
            case "ProGlo":
              return PromiseBB.resolve(seedSettings(destination, source));
            default:
              return PromiseBB.reject(err);
          }
        }),
      )
      .then(() =>
        copyType.endsWith("Glo")
          ? fs
              .copyAsync(source, destinationOrig, { noSelfCopy: true })
              .then(() =>
                fs.copyAsync(source, destinationOrig + ".baked", {
                  noSelfCopy: true,
                }),
              )
              .catch({ code: "ENOENT" }, (err) =>
                isMissingSource(source, err).then((missing) =>
                  gameSetting.optional && missing ? PromiseBB.resolve() : PromiseBB.reject(err),
                ),
              )
          : PromiseBB.resolve(),
      )
      .reflect()
      .then((result) => {
        if (result.isRejected()) firstFailure ??= result;
        return undefined;
      });
  }).then(() => {
    if (firstFailure !== undefined) throw firstFailure.reason();
    return undefined;
  });
}

function checkGlobalFiles(
  oldProfile: types.IProfile,
  newProfile: types.IProfile,
): PromiseBB<ISettingsFile[]> {
  let fileList: ISettingsFile[] = [];

  if (oldProfile !== undefined && gameSupported(oldProfile.gameId)) {
    fileList = fileList.concat(
      gameSettingsFiles(oldProfile.gameId, mygamesPath(oldProfile.gameId)),
    );
  }

  if (newProfile !== undefined && gameSupported(newProfile.gameId)) {
    fileList = fileList.concat(
      gameSettingsFiles(newProfile.gameId, mygamesPath(newProfile.gameId)),
    );
  }

  fileList = util.unique(fileList, (item) => item.name);

  return PromiseBB.filter(fileList, (file) =>
    file.optional
      ? PromiseBB.resolve(false)
      : fs
          .statAsync(file.name)
          .then(() => false)
          .catch(() => true),
  ).then((missingFiles: ISettingsFile[]) => {
    if (missingFiles.length > 0) {
      return PromiseBB.resolve(missingFiles);
    } else {
      return PromiseBB.resolve(null);
    }
  });
}

interface ISettingsStep {
  sourcePath: string;
  destinationPath: string;
  files: ISettingsFile[];
  copyType: string;
}

interface ISettingsSwap {
  oldProfile?: types.IProfile;
  newProfile?: types.IProfile;
  steps: ISettingsStep[];
  completed: number;
}

interface ISettingsRecovery {
  version: 1;
  installed: { [gameId: string]: types.IProfile };
  pending?: ISettingsSwap;
}

function sameSettings(left: string, right: string): boolean {
  if (left === right) return true;
  if (!gameSupported(left) || !gameSupported(right)) return false;
  const files = (gameId: string) =>
    gameSettingsFiles(gameId, mygamesPath(gameId))
      .map((file) => file.name)
      .sort();
  return JSON.stringify(files(left)) === JSON.stringify(files(right));
}

async function syncFiles(files: string[]): Promise<void> {
  for (const file of new Set(files)) {
    const fd = await fs.openAsync(file, "r");
    try {
      await fs.fsyncAsync(fd);
    } finally {
      await fs.closeAsync(fd);
    }
  }
}

function writeRecovery(filename: string, recovery: ISettingsRecovery): void {
  const temporary = filename + ".tmp";
  mkdirSync(path.dirname(filename), { recursive: true });
  try {
    const handle = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(handle, JSON.stringify(recovery));
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, filename);
    const directory = openSync(path.dirname(filename), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}

async function seedSettings(source: string, destination: string): Promise<void> {
  // Publish a complete first-use snapshot before it becomes a copy source.
  const temporary = destination + ".settings.tmp";
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.copyAsync(source, temporary, { noSelfCopy: true });
    await syncFiles([temporary]);
    await rename(temporary, destination);
    await syncFiles([path.dirname(destination), path.dirname(path.dirname(destination))]);
  } finally {
    await unlink(temporary).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
}

function prepareSettingsUpdate(
  oldProfile: types.IProfile,
  newProfile: types.IProfile,
): ISettingsStep[] {
  const steps: ISettingsStep[] = [];
  const add = (
    sourcePath: string,
    destinationPath: string,
    profile: types.IProfile,
    copyType: string,
  ) =>
    steps.push({
      sourcePath,
      destinationPath,
      files: gameSettingsFiles(profile.gameId, null),
      copyType,
    });

  if (oldProfile?.features?.local_game_settings && gameSupported(oldProfile.gameId)) {
    const myGames = mygamesPath(oldProfile.gameId);
    if ((oldProfile as any).pendingRemove !== true) {
      add(myGames, profilePath(oldProfile), oldProfile, "GloPro");
    }
    add(backupPath(oldProfile), myGames, oldProfile, "BacGlo");
  }
  if (newProfile?.features?.local_game_settings && gameSupported(newProfile.gameId)) {
    const myGames = mygamesPath(newProfile.gameId);
    add(myGames, backupPath(newProfile), newProfile, "GloBac");
    add(profilePath(newProfile), myGames, newProfile, "ProGlo");
  }
  return steps;
}

async function syncStep(step: ISettingsStep): Promise<void> {
  const destinations: string[] = [];
  for (const file of step.files) {
    const destination = path.join(step.destinationPath, path.basename(file.name));
    const files = step.copyType.endsWith("Glo")
      ? [destination + ".base", destination, destination + ".baked"]
      : [destination];
    for (const output of files) {
      try {
        await syncFiles([output]);
        destinations.push(path.dirname(output));
      } catch (err) {
        if (!file.optional || err.code !== "ENOENT") throw err;
        destinations.push(path.dirname(output));
      }
    }
  }
  await syncFiles([...destinations, path.dirname(step.destinationPath)]);
}

function onSwitchGameProfile(
  store: Redux.Store<any>,
  oldProfile: types.IProfile,
  newProfile: types.IProfile,
  update: () => PromiseBB<void>,
  checkFiles: boolean,
): PromiseBB<boolean> {
  // Recovery can recreate live files removed by a failed copy.
  const check = checkFiles ? checkGlobalFiles(oldProfile, newProfile) : PromiseBB.resolve(null);
  return check.then((missingFiles) => {
    if (missingFiles !== undefined && missingFiles !== null) {
      const fileList = missingFiles.map((fileName) => `"${fileName.name}"`).join("\n");
      util.showError(
        store.dispatch,
        "An error occurred activating profile",
        "Files are missing or not writeable:\n" +
          fileList +
          "\n\n" +
          "Some games need to be run at least once before they can be modded.",
        { allowReport: false },
      );
      return false;
    }

    return PromiseBB.try(update)
      .then(() => true)
      .catch(util.UserCanceled, (err) => {
        log("info", "User canceled game settings update", err);
        return false;
      })
      .catch((err) => {
        util.showError(store.dispatch, "An error occurred applying game settings", {
          error: err,
          "Old Game": (oldProfile || { gameId: "none" }).gameId,
          "New Game": (newProfile || { gameId: "none" }).gameId,
        });
        return false;
      });
  });
}

function onDeselectGameProfile(
  store: Redux.Store<any>,
  profile: types.IProfile,
): PromiseBB<boolean> {
  // It's possible for the profile to be undefined at this point
  //  if/when the user is not actively managing any games.
  if (!profile || !profile.features?.local_game_settings || !gameSupported(profile.gameId)) {
    return PromiseBB.resolve(true);
  }
  return checkGlobalFiles(undefined, profile)
    .then((missingFiles) => {
      if (missingFiles !== undefined && missingFiles !== null) {
        const fileList = missingFiles.map((fileName) => `"${fileName.name}"`).join("\n");
        util.showError(
          store.dispatch,
          "An error occurred activating profile",
          "Files are missing or not writeable:\n" +
            fileList +
            "\n\n" +
            "Some games need to be run at least once before they can be modded.",
          { allowReport: false },
        );
        return false;
      }
    })
    .then((checked) => {
      if (checked === false) return false;
      const myGames = mygamesPath(profile.gameId);
      const gameSettings = gameSettingsFiles(profile.gameId, null);

      return copyGameSettings(myGames, profilePath(profile), gameSettings, "GloPro").then(
        () => true,
      );
    });
}

function bakeSettings(
  api: types.IExtensionApi,
  profile: types.IProfile,
  recoverOnly = false,
): PromiseBB<void> {
  if (profile === undefined) {
    return PromiseBB.resolve();
  }
  const state: types.IState = api.store.getState();
  const gameMods = state.persistent.mods[profile.gameId] || [];
  const mods = Object.keys(gameMods)
    .filter((key) => util.getSafe(profile, ["modState", key, "enabled"], false))
    .map((key) => gameMods[key]);

  return PromiseBB.resolve(recoverOnly ? [] : util.sortMods(profile.gameId, mods, api)).then(
    (sortedMods) =>
      PromiseBB.resolve(
        api
          .emitAndAwait("bake-settings", profile.gameId, sortedMods, profile, {
            reportResult: true,
            settingsLocked: true,
            ...(recoverOnly ? { recoverOnly: true } : {}),
            optionalFiles: gameSupported(profile.gameId)
              ? gameSettingsFiles(profile.gameId, null)
                  .filter((file) => file.optional)
                  .map((file) => file.name)
              : [],
          })
          .then((results: Array<{ settingsBaked?: boolean; error?: Error }>) => {
            const failure = results.find((result) => result.settingsBaked === false);
            if (failure !== undefined) throw failure.error;
            if (!results.some((result) => result.settingsBaked === true)) {
              throw new Error("Game settings bake did not confirm completion");
            }
          }),
      ),
  );
}

function testGlobalFiles(api: types.IExtensionApi): PromiseBB<types.ITestResult> {
  const gameMode = selectors.activeGameId(api.getState());
  if (!gameSupported(gameMode)) {
    return PromiseBB.resolve(undefined);
  }
  let activeProfile = selectors.activeProfile(api.getState());
  if (activeProfile?.gameId == null) {
    return PromiseBB.resolve(undefined);
  }

  return checkGlobalFiles(undefined, activeProfile).then((missingFiles) => {
    if (missingFiles == null || missingFiles.length === 0) {
      return PromiseBB.resolve(undefined);
    }
    const fileList = missingFiles.map((fileName) => `"${fileName.name}"`).join("\n");
    return PromiseBB.resolve<types.ITestResult>({
      description: {
        short: "Missing or not writeable game files",
        long:
          "Files are missing or not writeable:\n" +
          fileList +
          "\n\n" +
          "Some games need to be run at least once before they can be modded.",
      },
      severity: "warning",
      onRecheck: () => {
        const state = api.getState();
        activeProfile = selectors.activeProfile(state);
        return checkGlobalFiles(undefined, activeProfile).then(
          (recheckMissingFiles) => !recheckMissingFiles || recheckMissingFiles.length === 0,
        )
          ? PromiseBB.resolve(undefined)
          : PromiseBB.resolve(testGlobalFiles(api));
      },
    });
  });
}

function init(context: types.IExtensionContext): boolean {
  initGameSupport(context.api);
  let ownershipReady = false;

  context.registerProfileFeature(
    "local_game_settings",
    "boolean",
    "settings",
    "Game Settings",
    "This profile has its own game settings",
    () => ownershipReady && gameSupported(selectors.activeGameId(context.api.store.getState())),
  );

  context.registerTest("check-global-files", "gamemode-activated", () =>
    testGlobalFiles(context.api),
  );

  context.once(() => {
    const store: Redux.Store<types.IState> = context.api.store;
    const installedProfiles = new Map<string, types.IProfile>();
    let changingProfile: types.IProfile;
    const initialState = store.getState();
    const active = selectors.activeProfile(initialState);
    for (const profile of Object.values(initialState.persistent.profiles)) {
      const installed =
        active?.gameId === profile.gameId
          ? active
          : initialState.persistent.profiles[
              selectors.lastActiveProfileForGame(initialState, profile.gameId)
            ];
      if (installed !== undefined) installedProfiles.set(profile.gameId, installed);
    }

    // Feature edits and profile switches share one durable file lifecycle.
    const recoveryPath = path.join(util.getVortexPath("userData"), "local-game-settings.json");
    let recovery: ISettingsRecovery;
    const resolveOwners = (installed: ISettingsRecovery["installed"], bootstrap = false) => {
      const owners = { ...installed };
      for (const game of Object.keys(installed)) {
        if (owners[game] === undefined) continue;
        for (const other of Object.keys(owners)) {
          if (game === other || !sameSettings(game, other)) continue;
          // A legacy journal cannot distinguish an unconfirmed shared-file install.
          if (!bootstrap || ![game, other].includes(active?.gameId)) {
            throw new Error("Shared game settings ownership is ambiguous during recovery");
          }
          delete owners[active.gameId === game ? other : game];
        }
      }
      return owners;
    };
    const loadRecovery = () => {
      if (recovery !== undefined) return;
      let persisted: ISettingsRecovery;
      try {
        persisted = JSON.parse(readFileSync(recoveryPath, "utf8"));
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
        const initial: ISettingsRecovery = {
          version: 1,
          installed: resolveOwners(Object.fromEntries(installedProfiles), true),
        };
        writeRecovery(recoveryPath, initial);
        installedProfiles.clear();
        for (const [game, profile] of Object.entries(initial.installed))
          installedProfiles.set(game, profile);
        recovery = initial;
        ownershipReady = true;
        return;
      }
      const validProfile = (profile: types.IProfile) =>
        profile != null && typeof profile.id === "string" && typeof profile.gameId === "string";
      const pending = persisted?.pending;
      if (
        persisted?.version !== 1 ||
        persisted.installed == null ||
        typeof persisted.installed !== "object" ||
        Array.isArray(persisted.installed) ||
        !Object.entries(persisted.installed).every(
          ([game, profile]) => validProfile(profile) && profile.gameId === game,
        ) ||
        (pending !== undefined &&
          (pending == null ||
            (pending.oldProfile !== undefined && !validProfile(pending.oldProfile)) ||
            (pending.newProfile !== undefined && !validProfile(pending.newProfile)) ||
            !Array.isArray(pending.steps) ||
            !Number.isInteger(pending.completed) ||
            pending.completed < 0 ||
            pending.completed > Math.max(0, pending.steps.length - 1) ||
            JSON.stringify(pending.steps) !==
              JSON.stringify(prepareSettingsUpdate(pending.oldProfile, pending.newProfile))))
      ) {
        throw new Error("Game settings recovery data is invalid or its paths have changed");
      }
      const installed = resolveOwners(persisted.installed);
      for (const [game, profile] of installedProfiles) {
        if (!Object.keys(installed).some((owner) => sameSettings(game, owner)))
          installed[game] = profile;
      }
      const loaded = { ...persisted, installed };
      if (JSON.stringify(loaded.installed) !== JSON.stringify(persisted.installed))
        writeRecovery(recoveryPath, loaded);
      installedProfiles.clear();
      for (const [game, profile] of Object.entries(installed)) installedProfiles.set(game, profile);
      recovery = loaded;
      ownershipReady = true;
    };
    const persist = (next: ISettingsRecovery): PromiseBB<void> =>
      PromiseBB.try(() => writeRecovery(recoveryPath, next)).then(() => {
        recovery = next;
      });
    const settingsHandoff = (
      installed: ISettingsRecovery["installed"],
      completedSwap = false,
    ): ISettingsSwap | undefined => {
      const state = store.getState();
      const active = selectors.activeProfile(state);
      for (const [gameId, owner] of Object.entries(installed)) {
        const selectedId =
          changingProfile !== undefined &&
          sameSettings(changingProfile.gameId, gameId) &&
          (!completedSwap || owner.id === changingProfile.id)
            ? changingProfile.id
            : active !== undefined && sameSettings(active.gameId, gameId)
              ? active.id
              : selectors.lastActiveProfileForGame(state, gameId);
        const selected = state.persistent.profiles[selectedId];
        if (
          selectedId !== undefined &&
          (selected?.id !== selectedId ||
            !sameSettings(selected.gameId, gameId) ||
            selected.pendingRemove === true)
        ) {
          throw new Error("Game settings recovery profile is unavailable");
        }
        if (
          selected !== undefined &&
          (owner.id !== selected.id ||
            !!owner.features?.local_game_settings !== !!selected.features?.local_game_settings)
        ) {
          return {
            oldProfile: owner,
            newProfile: selected,
            steps: prepareSettingsUpdate(owner, selected),
            completed: 0,
          };
        }
      }
      return undefined;
    };
    const applyPendingSettings = (reconcile = false): PromiseBB<void> => {
      const pending = recovery.pending;
      if (pending === undefined) return PromiseBB.resolve();
      const checkPaths = () => {
        if (
          JSON.stringify(pending.steps) !==
          JSON.stringify(prepareSettingsUpdate(pending.oldProfile, pending.newProfile))
        ) {
          throw new Error("Game settings paths changed during recovery");
        }
      };
      checkPaths();
      // Recover interrupted publication before replay can replace or remove its live file.
      const profiles = [pending.oldProfile, pending.newProfile].filter(
        (profile, index, all) =>
          profile !== undefined &&
          all.findIndex((other) => other?.gameId === profile.gameId) === index,
      );
      return PromiseBB.resolve()
        .then(() => {
          if (reconcile)
            return PromiseBB.each(profiles, (profile) =>
              bakeSettings(context.api, profile, true),
            ).then(() => undefined);
        })
        .then(() =>
          PromiseBB.each(pending.steps.slice(pending.completed), (step, offset) =>
            copyGameSettings(step.sourcePath, step.destinationPath, step.files, step.copyType)
              .then(() => syncStep(step))
              .then(() => {
                const completed = pending.completed + offset + 1;
                // Repeat the final install after interruption, including a partial bake.
                return completed < pending.steps.length
                  ? persist({ ...recovery, pending: { ...pending, completed } })
                  : undefined;
              }),
          ),
        )
        .then(() => {
          checkPaths();
          const profile = pending.newProfile;
          const current = store.getState().persistent.profiles[profile?.id];
          return bakeSettings(
            context.api,
            profile === undefined
              ? undefined
              : {
                  ...profile,
                  ...current,
                  modState: current?.modState ?? profile.modState,
                  features: {
                    ...(current ?? profile).features,
                    local_game_settings: profile.features?.local_game_settings,
                  },
                },
          );
        })
        .then(() => {
          const last = pending.steps[pending.steps.length - 1];
          return last === undefined ? undefined : syncStep(last);
        })
        .then(() => {
          checkPaths();
          const installed = { ...recovery.installed };
          if (pending.newProfile !== undefined) {
            for (const game of Object.keys(installed))
              if (
                game !== pending.newProfile.gameId &&
                sameSettings(game, pending.newProfile.gameId)
              )
                delete installed[game];
            installed[pending.newProfile.gameId] = pending.newProfile;
          } else if (pending.oldProfile !== undefined) {
            installed[pending.oldProfile.gameId] = {
              ...pending.oldProfile,
              features: { ...pending.oldProfile.features, local_game_settings: false },
            };
          }
          const handoff = reconcile ? settingsHandoff(installed) : undefined;
          if (handoff !== undefined) {
            return persist({ version: 1, installed, pending: handoff }).then(() =>
              applyPendingSettings(true),
            );
          }
          return persist({ version: 1, installed }).then(() => {
            installedProfiles.clear();
            for (const [game, profile] of Object.entries(installed))
              installedProfiles.set(game, profile);
          });
        });
    };
    const resumeSettings = (): PromiseBB<boolean> => {
      // Installed files can lead core confirmation even after copies finish.
      const pending = recovery.pending ?? settingsHandoff(recovery.installed, true);
      return pending === undefined
        ? PromiseBB.resolve(true)
        : onSwitchGameProfile(
            store,
            pending.oldProfile,
            pending.newProfile,
            () =>
              (recovery.pending === undefined
                ? bakeSettings(context.api, installedProfile(pending.oldProfile)).then(() =>
                    persist({ ...recovery, pending }),
                  )
                : PromiseBB.resolve()
              ).then(() => applyPendingSettings(true)),
            false,
          );
    };
    let settingsQueue = PromiseBB.resolve();
    const recoveryIncomplete = new Error("Game settings recovery is incomplete");
    const serialize = <T>(operation: () => PromiseBB<T>): PromiseBB<T> => {
      const result = settingsQueue
        .then(loadRecovery)
        .then(resumeSettings)
        .then((recovered) => {
          if (!recovered) throw recoveryIncomplete;
          return operation();
        });
      settingsQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    context.api.events.on(
      "game-settings-operation",
      (operation: () => PromiseBB<unknown>, receive: (result: PromiseBB<unknown>) => void) =>
        receive(serialize(operation)),
    );
    const ownerForGame = (gameId: string): types.IProfile =>
      [...installedProfiles.values()].find((owner) => sameSettings(owner.gameId, gameId));
    const installedProfile = (profile: types.IProfile): types.IProfile => {
      const installed = ownerForGame(profile?.gameId);
      const current = store.getState().persistent.profiles[installed?.id] ?? installed;
      return installed === undefined
        ? profile
        : {
            ...current,
            features: {
              ...current.features,
              local_game_settings: installed.features?.local_game_settings,
            },
          };
    };
    const switchSettings = (oldProfile: types.IProfile, newProfile: types.IProfile) => {
      const steps = prepareSettingsUpdate(oldProfile, newProfile);
      return onSwitchGameProfile(
        store,
        oldProfile,
        newProfile,
        () =>
          persist({ ...recovery, pending: { oldProfile, newProfile, steps, completed: 0 } }).then(
            () => applyPendingSettings(),
          ),
        true,
      );
    };

    // Establish ownership before an editable feature can be persisted.
    try {
      loadRecovery();
    } catch (err) {
      context.api.showErrorNotification("Failed to recover game settings", err);
    }

    context.api.onStateChange(["persistent", "profiles"], (previous, current) => {
      const changes = Object.keys(current).filter(
        (id) =>
          previous[id] !== undefined &&
          !!previous[id].features?.local_game_settings !==
            !!current[id].features?.local_game_settings &&
          gameSupported(current[id].gameId),
      );
      if (!ownershipReady) {
        for (const id of changes) {
          const value = initialState.persistent.profiles[id]?.features?.local_game_settings;
          if (current[id].features?.local_game_settings !== value)
            store.dispatch(actions.setFeature(id, "local_game_settings", value));
        }
        return PromiseBB.resolve();
      }
      return PromiseBB.mapSeries(changes, (id) =>
        serialize(() => {
          const profile = store.getState().persistent.profiles[id];
          if (profile === undefined) return PromiseBB.resolve();
          const installed = installedProfiles.get(profile.gameId);
          if (
            installed?.id !== id ||
            !!installed.features?.local_game_settings === !!profile.features?.local_game_settings
          ) {
            return PromiseBB.resolve();
          }
          const oldProfile = installedProfile(profile);
          return bakeSettings(context.api, oldProfile)
            .then(() => switchSettings(oldProfile, profile))
            .then(() => undefined);
        }).catch((err) => {
          if (err !== recoveryIncomplete)
            context.api.showErrorNotification("failed to swap game settings file", err);
        }),
      ).then(() => undefined);
    });

    context.api.events.on(
      "profile-will-change",
      (
        nextProfileId: string,
        enqueue: (cb: () => PromiseBB<void>) => void,
        guardSnapshot?: (
          guard: (save: () => PromiseLike<void>) => PromiseLike<void>,
          cleanup: () => void,
        ) => void,
      ) => {
        const state = store.getState();

        const oldProfileId = util.getSafe(
          state,
          ["settings", "profiles", "activeProfileId"],
          undefined,
        );
        const outgoingProfile = state.persistent.profiles[oldProfileId];
        const newProfile = state.persistent.profiles[nextProfileId];

        guardSnapshot?.(
          (save) => {
            // Core confirms this selection after deployment finishes.
            changingProfile = newProfile;
            return PromiseBB.try(loadRecovery).then(save);
          },
          () => {
            changingProfile = undefined;
          },
        );

        const oldGameId = util.getSafe(outgoingProfile, ["gameId"], undefined);
        const newGameId = util.getSafe(newProfile, ["gameId"], undefined);

        if (sameSettings(oldGameId, newGameId)) {
          enqueue(() =>
            serialize(() => {
              const oldProfile = installedProfile(outgoingProfile);
              return bakeSettings(context.api, oldProfile).then(() =>
                switchSettings(oldProfile, newProfile).then(() => null),
              );
            }),
          );
        } else {
          const lastActiveProfileId =
            newProfile !== undefined
              ? selectors.lastActiveProfileForGame(state, newProfile.gameId)
              : undefined;
          const lastProfile =
            newProfile !== undefined ? state.persistent.profiles[lastActiveProfileId] : undefined;
          enqueue(() =>
            serialize(() => {
              const oldProfile = installedProfile(outgoingProfile);
              const lastActiveProfile = installedProfile(ownerForGame(newGameId) ?? lastProfile);
              return (
                bakeSettings(context.api, oldProfile)
                  .then(() => onDeselectGameProfile(store, oldProfile))
                  // all settings changes that have been made in the meantime still belong
                  // to the last active profile. Just in case lastActiveProfile and newProfile are
                  // different (which should *not* ever be the case) we need to bake these
                  // settings now so they don't get overridden
                  .tap(() => bakeSettings(context.api, lastActiveProfile))
                  .then((success: boolean) =>
                    success && newProfile !== undefined
                      ? switchSettings(lastActiveProfile, newProfile)
                      : PromiseBB.resolve(success),
                  )
                  .catch(util.CycleError, (err) => {
                    // this should be reported to the user elsewhere
                    log("warn", "settings couldn't be baked because mod rules contain cycles", err);
                  })
                  .catch((err) => {
                    const usercanceled = err instanceof util.UserCanceled;
                    context.api.showErrorNotification("failed to swap game settings file", err, {
                      allowReport: !usercanceled,
                    });
                  })
                  .then(() => null)
              );
            }),
          );
        }
      },
    );
    if (!ownershipReady) return;
    return serialize(() => PromiseBB.resolve()).catch((err) => {
      if (err !== recoveryIncomplete)
        context.api.showErrorNotification("Failed to recover game settings", err);
    });
  });
  return true;
}

export default init;
