/**
 * Manages profiles
 *
 * New API:
 *  registerProfileFile(gameId: string, filePath: string) - registers a file to be
 *    included in the profile so it gets stored in the profile and switched when the
 *    profile gets changed
 * State:
 *   settings.profiles.activeProfileId: string - currently active profile id
 *   persistent.profiles: { [gameId: string]: { [profileId: string]: IProfile } } -
 *      dictionary of all profiles
 * Actions:
 *   setProfile(gameId: string, profile: IProfile) - adds a new profile or changes an existing one
 *   setNextProfile(gameId: string, profileId: string) - activates a profile
 *   setModEnabled(gameId: string, profileId: string, modId: string, enabled: boolean) -
 *      enables or disables a mod in the current profile
 */

import * as path from "path";

import { getErrorMessageOrDefault } from "@vortex/shared";
import PromiseBB from "bluebird";
import type * as Redux from "redux";
import { generate as shortid } from "shortid";

import type { IDialogResult } from "../../actions/notifications";
import { addNotification, showDialog } from "../../actions/notifications";
import { clearUIBlocker, setProgress, setUIBlocker } from "../../actions/session";
import { log } from "../../logging";
import type { IAvailableExtension, IRegisteredExtension } from "../../types/extensions";
import type { IExtensionApi, IExtensionContext, ThunkStore } from "../../types/IExtensionContext";
import type { IGameStored, IState } from "../../types/IState";
import { relaunch } from "../../util/commandLine";
import {
  ProcessCanceled,
  ServiceTemporarilyUnavailable,
  SetupError,
  TemporaryError,
  UserCanceled,
} from "../../util/CustomErrors";
import { withTrackedActivity } from "../../util/errorHandling";
import * as fs from "../../util/fs";
import getVortexPath from "../../util/getVortexPath";
import { showError } from "../../util/message";
import onceCB from "../../util/onceCB";
import {
  discoveryByGame,
  gameById,
  installPathForGame,
  needToDeployForGame,
} from "../../util/selectors";
import { getSafe } from "../../util/storeHelper";
import { truthy } from "../../util/util";
import { emitGameManaged, emitGameUnmanaged } from "../analytics/mixpanel/gameManageAnalytics";
import { fetchAvailableExtensions } from "../extension_manager/util";
import { getGame, getGameStubDownloadInfo } from "../gamemode_management/util/getGame";
import { ensureStagingDirectory } from "../mod_management/stagingDirectory";
import { purgeMods } from "../mod_management/util/deploy";
import { NoDeployment } from "../mod_management/util/exceptions";
import { nexusGameId } from "../nexus_integration/util/convertGameId";
import {
  removeProfile,
  setProfile,
  setProfileActivated,
  willRemoveProfile,
} from "./actions/profiles";
import { clearLastActiveProfile, setCurrentProfile, setNextProfile } from "./actions/settings";
import { STUCK_TIMEOUT } from "./constants";
import { profilesReducer } from "./reducers/profiles";
import { settingsReducer } from "./reducers/settings";
import transferSetupReducer from "./reducers/transferSetup";
import { activeGameId, activeProfile, lastActiveProfileForGame, profileById } from "./selectors";
import { syncFromProfile, syncToProfile } from "./sync";
import { CorruptActiveProfile } from "./types/Errors";
import type { IProfile } from "./types/IProfile";
import type { IProfileFeature } from "./types/IProfileFeature";
import { sanitizeProfile } from "./util/sanitizeProfile";
import Connector from "./views/Connector";
import ProfileView from "./views/ProfileView";
import TransferDialog from "./views/TransferDialog";

const profileFiles: {
  [gameId: string]: Array<string | (() => PromiseLike<string[]>)>;
} = {};

const profileFeatures: IProfileFeature[] = [];

declare module "../../types/IExtensionContext" {
  interface ApiEvents {
    "manage-game-for-install": (gameId: string) => boolean;
  }
}

function profilePath(profile: IProfile): string {
  return path.join(getVortexPath("userData"), profile.gameId, "profiles", profile.id);
}

function checkProfile(store: Redux.Store<any>, currentProfile: IProfile): PromiseBB<void> {
  return fs.ensureDirAsync(profilePath(currentProfile));
}

function refreshProfile(
  store: Redux.Store<any>,
  profile: IProfile,
  direction: "import" | "export",
): PromiseBB<void> {
  log("debug", "refresh profile", { profile, direction });
  if (profile === undefined || profile?.pendingRemove === true) {
    return PromiseBB.resolve();
  }
  if (profile.gameId === undefined || profile.id === undefined) {
    return PromiseBB.reject(new CorruptActiveProfile(profile));
  }
  return checkProfile(store, profile)
    .then(() => profilePath(profile))
    .then((currentProfilePath: string) => {
      // if this is the first sync, we assume the files on disk belong
      // to the profile that was last active in Vortex. This could only be
      // false if the profile was somehow changed before without a
      // syncFromProfile happening. Of course if the profile was never
      // loaded then it has no copies of the files but that if fine.
      const gameId = profile.gameId;
      if (profileFiles[gameId] === undefined) {
        return PromiseBB.resolve();
      }
      return PromiseBB.all(
        profileFiles[gameId].map((iter) => {
          return typeof iter === "string" ? PromiseBB.resolve([iter]) : iter();
        }),
      )
        .then((fileLists) => [].concat(...fileLists))
        .then((filePaths) => {
          if (direction === "import") {
            return syncToProfile(currentProfilePath, filePaths, (error, detail, allowReport) =>
              showError(store.dispatch, error, detail, { allowReport }),
            );
          } else {
            return syncFromProfile(currentProfilePath, filePaths, (error, detail, allowReport) =>
              showError(store.dispatch, error, detail, { allowReport }),
            );
          }
        });
    });
}

/**
 * activate the specified game (using the last active profile for that game).
 * Will ask the user if the game was never active (how would this happen?)
 *
 * @param {string} gameId
 */
function activateGame(store: ThunkStore<IState>, gameId: string): PromiseBB<void> {
  const state: IState = store.getState();
  const gamePath = getSafe(
    state,
    ["settings", "gameMode", "discovered", gameId, "path"],
    undefined,
  );
  if (gamePath === undefined) {
    store.dispatch(
      addNotification({
        type: "warning",
        title: "{{gameId}} not enabled",
        message: "Game no longer discovered",
        replace: {
          gameId,
        },
      }),
    );
    log("info", "unselecting profile because game no longer discovered", {
      gameId,
    });
    store.dispatch(setNextProfile(undefined));
    return PromiseBB.resolve();
  }

  log("info", "activating game", { gameId, gamePath });

  const profileId = getSafe(
    state,
    ["settings", "profiles", "lastActiveProfile", gameId],
    undefined,
  );
  const profile = getSafe(state, ["persistent", "profiles", profileId], undefined);
  if (profile?.gameId !== gameId || profile.pendingRemove) {
    const profiles = getSafe(state, ["persistent", "profiles"], []);
    const gameProfiles: IProfile[] = Object.keys(profiles)
      .filter((id: string) => profiles[id].gameId === gameId && !profiles[id].pendingRemove)
      .map((id: string) => profiles[id]);
    return store
      .dispatch(
        showDialog(
          "question",
          "Choose profile",
          {
            text: "Please choose the profile to use with this game",
            choices: gameProfiles.map((iter: IProfile, idx: number) => ({
              id: iter.id,
              text: iter.name,
              value: idx === 0,
            })),
          },
          [{ label: "Activate" }],
        ),
      )
      .then((dialogResult: IDialogResult) => {
        if (dialogResult.action === "Activate") {
          const selectedId = Object.keys(dialogResult.input).find(
            (id: string) => dialogResult.input[id],
          );
          const selected = profileById(store.getState(), selectedId);
          if (selected?.gameId !== gameId || selected.pendingRemove) return;
          log("info", "user selected profile", { selectedId });
          store.dispatch(setNextProfile(selectedId));
        }
      });
  } else {
    log("info", "using last active profile", { profileId });
    // actually, we have to verify that game is still discovered, otherwise we can't
    // activate it
    const fbProfile = state.persistent.profiles?.[profileId];
    const discovery = state.settings.gameMode.discovered?.[fbProfile?.gameId];
    if (discovery?.path !== undefined) {
      store.dispatch(setNextProfile(profileId));
    } else {
      store.dispatch(setNextProfile(undefined));
    }
    return PromiseBB.resolve();
  }
}

/** Deploys the profile unless it is its game's last active one with nothing pending. */
function deploy(api: IExtensionApi, profileId: string | undefined, what: string): PromiseBB<void> {
  const state: IState = api.store.getState();
  if (profileId === undefined || state.persistent.profiles[profileId] === undefined) {
    return PromiseBB.resolve();
  }

  const profile = profileById(state, profileId);
  if (
    profileId === lastActiveProfileForGame(state, profile.gameId) &&
    !needToDeployForGame(state, profile.gameId)
  ) {
    return PromiseBB.resolve();
  }

  const gameDiscovery = getSafe(
    state,
    ["settings", "gameMode", "discovered", profile.gameId],
    undefined,
  );
  if (gameDiscovery?.path === undefined) {
    // can't deploy a game that hasn't been discovered
    return PromiseBB.resolve();
  }

  log("info", `will deploy ${what}`, profileId);

  let lastProgress: number = Date.now();

  const watchdog = setInterval(() => {
    if (Date.now() - lastProgress > STUCK_TIMEOUT) {
      api.store.dispatch(
        setProgress(
          "profile",
          "deploying",
          api.translate("Stuck? Please check your vortex.log file."),
          0,
        ),
      );
    }
  }, 1000);

  return new PromiseBB<void>((resolve, reject) => {
    api.events.emit(
      "deploy-mods",
      onceCB((err: Error) => {
        clearInterval(watchdog);
        if (err === null) {
          log("info", `did deploy ${what}`, profileId);
          resolve();
        } else {
          reject(err);
        }
      }),
      profileId,
      (text: string, percent: number) => {
        lastProgress = Date.now();
        api.store.dispatch(setProgress("profile", "deploying", text, percent));
      },
      { failOnError: true },
    );
  });
}

/* generates a profile change handler.
 * that is: it reacts to the "next profile" being changed, which triggers the
 * "active profile" being updated. "onFinishProfileSwitch" registers a callback
 * which will signal when the active profile has been updated, only then will the
 * next profile switch be allowed.
 */
function genOnProfileChange(
  api: IExtensionApi,
  onFinishProfileSwitch: (callback: () => void) => void,
  startupSync: PromiseBB<void>,
) {
  let finishProfileSwitchPromise: PromiseBB<void> = startupSync;
  const { store } = api;

  let cancelPromise: () => void;

  const invokeCancel = () => {
    if (cancelPromise !== undefined) {
      onFinishProfileSwitch(undefined);
      cancelPromise();
      cancelPromise = undefined;
    }
  };

  const cancelSwitch = (previousId?: string) => {
    invokeCancel();
    const candidate = profileById(store.getState(), previousId);
    const previous =
      typeof candidate?.id === "string" &&
      candidate.id.length > 0 &&
      candidate.id === previousId &&
      typeof candidate.gameId === "string" &&
      candidate.gameId.length > 0 &&
      candidate.pendingRemove !== true
        ? candidate
        : undefined;
    store.dispatch(setCurrentProfile(previous?.gameId, previous?.id));
    store.dispatch(setNextProfile(previous?.id));
  };

  const confirmProfile = (gameId: string, current: string) => {
    store.dispatch(setCurrentProfile(gameId, current));
    if (current !== undefined) {
      store.dispatch(setProfileActivated(current));
    }
    const confirmPromise = cancelPromise;
    setTimeout(() => {
      if (confirmPromise === cancelPromise && cancelPromise !== undefined) {
        log("warn", "active profile switch didn't get confirmed?");
        invokeCancel();
      }
    }, 2000);
  };

  let changeQueue = startupSync;
  return (prev: string, current: string) => {
    let outgoingSaved = false;
    const snapshotCleanup: Array<() => void> = [];
    const change = changeQueue
      .then(() => finishProfileSwitchPromise)
      .then(() => {
        const state: IState = store.getState();
        prev = state.settings.profiles.activeProfileId;
        log("debug", "profile change", { from: prev, to: current });
        if (state.settings.profiles.nextProfileId !== current) {
          // cancel if there was another profile switch while we waited
          return null;
        }

        if (state.settings.profiles.activeProfileId === current) {
          // also do nothing if we're actually resetting the nextprofile
          return null;
        }

        const profile = state.persistent.profiles[current];
        if (profile === undefined && current !== undefined) {
          return PromiseBB.reject(new Error("Tried to set invalid profile"));
        }

        if (profile !== undefined) {
          const { gameId } = profile;
          const game = getGame(gameId);
          if (game === undefined) {
            showError(
              store.dispatch,
              "Game no longer supported, please install the game extension",
              undefined,
              { message: profile.gameId, allowReport: false },
            );
            return PromiseBB.reject(new ProcessCanceled("Game no longer supported"));
          }

          const discovery = state.settings.gameMode.discovered[profile.gameId];
          if (discovery?.path === undefined) {
            showError(
              store.dispatch,
              "Game is no longer discoverable, please go to the games page and scan for, or " +
                "manually select the game folder.",
              profile.gameId,
              { allowReport: false },
            );
            return PromiseBB.reject(new ProcessCanceled("Game no longer discovered"));
          }
        }

        finishProfileSwitchPromise = new PromiseBB<void>((resolve, reject) => {
          cancelPromise = resolve;
          onFinishProfileSwitch(() => {
            cancelPromise = undefined;
            resolve();
          });
        }).catch((err) => {
          showError(store.dispatch, "Profile switch failed", err);
          return PromiseBB.resolve();
        });

        // IMPORTANT: After this point we expect an external signal to tell
        //   us when the active profile has been updated, otherwise we will not
        //   allow the next profile switch
        //   any error handler *has* to cancel this confirmation!

        let queue: PromiseBB<void> = PromiseBB.resolve();
        // emit an event notifying about the impending profile change.
        // every listener can return a cb returning a promise which will be
        // awaited before continuing.
        // It would be fun if we could cancel the profile change if one of
        // these promises is rejected but that would only work if we could roll back
        // changes that happened.
        const enqueue = (cb: () => PromiseBB<void>) => {
          queue = queue.then(() =>
            PromiseBB.try(cb).catch((err) => {
              const message = getErrorMessageOrDefault(err);
              log("error", "error in profile-will-change handler", message);
            }),
          );
        };

        const oldProfile = state.persistent.profiles[prev];
        let snapshot = () => refreshProfile(store, oldProfile, "import");
        const guardSnapshot = (
          guard: (save: () => PromiseLike<void>) => PromiseLike<void>,
          cleanup: () => void,
        ) => {
          const save = snapshot;
          snapshot = () => PromiseBB.resolve(guard(save));
          snapshotCleanup.push(cleanup);
        };
        // changes to profile files are only saved back to the profile at this point
        queue = queue
          .then(() => snapshot())
          .then(() => {
            outgoingSaved = true;
          });

        api.events.emit("profile-will-change", current, enqueue, guardSnapshot);

        if (current === undefined) {
          log("info", "switched to no profile");
          return queue.then(() => confirmProfile(undefined, undefined));
        }

        sanitizeProfile(store, profile);

        // Cross-game: skip the outgoing profile and a last-active incoming one; deploy the
        // incoming game's pending last-active profile first.
        const switchesGame = oldProfile !== undefined && oldProfile.gameId !== profile.gameId;
        const lastActiveId = lastActiveProfileForGame(state, profile.gameId);
        const pendingId =
          switchesGame && current !== lastActiveId && needToDeployForGame(state, profile.gameId)
            ? lastActiveId
            : undefined;
        const prevId = switchesGame ? undefined : prev;
        const nextId = switchesGame && current === lastActiveId ? undefined : current;

        return PromiseBB.resolve(
          withTrackedActivity(
            "vortex.profile-management",
            "profile.switch",
            {
              "profile.from": prev,
              "profile.to": current,
              "profile.gameId": profile?.gameId,
            },
            () =>
              queue
                .then(() => {
                  if (pendingId === undefined) {
                    return undefined;
                  }
                  return deploy(api, pendingId, "pending profile").then(() =>
                    refreshProfile(store, profileById(api.getState(), pendingId), "import"),
                  );
                })
                .then(() => {
                  log("debug", "starting refresh profile export");
                  return refreshProfile(store, profile, "export");
                })
                // ensure the old profile is synchronised before we switch, otherwise me might
                // revert some changes
                .then(() => deploy(api, prevId, "previously active profile"))
                .then(() => deploy(api, nextId, "next active profile"))
                .then(() => {
                  const prof = profileById(api.store.getState() as IState, current);
                  if (prof === undefined) {
                    return PromiseBB.reject(
                      new ProcessCanceled(
                        "Profile was deleted during deployment. " +
                          "Why would you do something like that???",
                      ),
                    );
                  }

                  api.store.dispatch(setProgress("profile", "deploying", undefined, undefined));
                  const gameId = profile !== undefined ? profile.gameId : undefined;
                  log("info", "switched to profile", { gameId, current });
                  confirmProfile(gameId, current);
                  return null;
                }),
          ),
        );
      })
      .catch((err) => {
        cancelSwitch(outgoingSaved ? undefined : prev);
        return PromiseBB.reject(err);
      })
      .catch(ProcessCanceled, (err) => {
        showError(store.dispatch, "Failed to set profile", err.message, {
          allowReport: false,
        });
      })
      .catch(SetupError, (err) => {
        showError(store.dispatch, "Failed to set profile", err.message, {
          allowReport: false,
        });
      })
      .catch(CorruptActiveProfile, (err) => {
        // AFAICT the only way for this error to pop up is when upgrading from
        //  an ancient version of Vortex which probably had a bug in it which we
        //  fixed a long time ago. Corrupt profiles are automatically removed by
        //  our verifiers and the user will just have to create a new profile for
        //  their game - not much we can do to help him with that.
        showError(store.dispatch, "Failed to set profile", err, {
          allowReport: false,
        });
      })
      .catch(UserCanceled, () => null)
      .catch((err) => {
        showError(store.dispatch, "Failed to set profile", err);
      })
      .finally(() => {
        snapshotCleanup.forEach((cleanup) => cleanup());
      });
    changeQueue = change;
    return change;
  };
}

function manageGameDiscovered(api: IExtensionApi, gameId: string) {
  const gamePath = discoveryByGame(api.getState(), gameId)?.path;
  const profileId = shortid();
  // initialize the staging directory.
  // It's not great that this is here, the code would better fit into mod_management
  // but I'm not entirely sure what could happen if it's not initialized right away.
  // Since the dir has to be tagged we can't just sprinkle "ensureDir" anywhere we want
  // to access it.
  return ensureStagingDirectory(api, undefined, gameId)
    .then(() => {
      const state = api.getState();
      if (
        !gamePath ||
        discoveryByGame(state, gameId)?.path !== gamePath ||
        state.session.gameMode.disabled?.[gameId] !== undefined
      )
        return false;
      log("info", "user managing game for the first time", { gameId });
      api.store.dispatch(
        setProfile({
          id: profileId,
          gameId,
          name: "Default",
          modState: {},
          lastActivated: undefined,
        }),
      );
      api.store.dispatch(setNextProfile(profileId));
      emitGameManaged(api, gameId);
      return true;
    })
    .catch((err) => {
      const instPath = installPathForGame(api.store.getState(), gameId);
      api.showErrorNotification("The game location doesn't exist or isn't writeable", err, {
        allowReport: false,
        message: instPath,
      });
      return false;
    });
}

async function offerGameExtension(api: IExtensionApi, gameId: string, forInstall: boolean) {
  const stub = getGameStubDownloadInfo(gameId);
  const game = getGame(gameId);
  const domain = nexusGameId(game, gameId);
  const match = (catalog: IAvailableExtension[]) => {
    const games = catalog.filter((ext) => ext?.type === "game" && ext.modId > 0 && ext.fileId > 0);
    return (
      games.find((ext) => ext.gameDomain === gameId) ??
      games.find((ext) => ext.gameDomain === domain) ??
      catalog.find(
        (ext) =>
          stub &&
          ext?.modId === stub.modId &&
          ext.fileId > 0 &&
          ext.type == null &&
          (ext.gameDomain == null || ext.gameDomain === domain),
      ) ??
      games.find((ext) => ext.modId === stub?.modId && ext.gameDomain == null) ??
      games.find((ext) => ext.gameDomain === undefined && ext.name === gameId)
    );
  };
  const stubProvider = stub?.modId > 0 && stub.fileId > 0 ? stub : undefined;
  const catalogEntry =
    match(api.getState().session.extensions.available) ??
    (await fetchAvailableExtensions(api, true).then(match, (err) => {
      if (stubProvider === undefined) throw err;
      return undefined;
    }));
  const extension = catalogEntry ?? stubProvider;
  if (extension === undefined) {
    throw new ProcessCanceled(
      `No game support extension is available for "${game?.name ?? gameId}".`,
    );
  }

  const result = await api.showDialog(
    "question",
    "Game support not installed",
    {
      text:
        'To manage "{{gameName}}", download its game support extension and restart Vortex.' +
        (forInstall
          ? " After game setup, open All downloads and choose Install for the downloaded archive."
          : ""),
      parameters: { gameName: game?.name ?? catalogEntry?.gameName ?? extension.name },
    },
    [{ label: "Cancel" }, { label: "Download" }],
  );
  if (result.action !== "Download") return;

  api.store.dispatch(
    setUIBlocker(
      "installing-game",
      "download",
      "Installing Game, Vortex will restart upon completion.",
      true,
    ),
  );
  try {
    await api.ext.ensureLoggedIn();
    const results = await api.emitAndAwait("install-extension", extension);
    if (results.includes(true)) {
      relaunch(["--game", stub !== undefined ? gameId : extension.name]);
    }
  } finally {
    api.store.dispatch(clearUIBlocker("installing-game"));
  }
}

async function manageGame(
  api: IExtensionApi,
  gameId: string,
  forInstall: boolean,
): Promise<boolean> {
  await checkOverridden(api, gameId);
  const game = gameById(api.getState(), gameId);
  if (game === undefined) {
    await offerGameExtension(api, gameId, forInstall);
    return false;
  }

  await api.emitAndAwait("discover-game", gameId);
  await checkOverridden(api, gameId);
  if (discoveryByGame(api.getState(), gameId)?.path === undefined) {
    const result = await api.showDialog(
      "question",
      "Game not discovered",
      {
        text: '"{{gameName}}" was not discovered. Select its game folder to continue.',
        parameters: { gameName: game.name },
      },
      [{ label: "Cancel" }, { label: "Continue" }],
    );
    if (result.action !== "Continue") return false;
    await new Promise<void>((resolve, reject) => {
      api.events.emit("manually-set-game-location", gameId, (err: Error) => {
        if (err != null) reject(err);
        else resolve();
      });
    });
    if (discoveryByGame(api.getState(), gameId)?.path === undefined) return false;
  } else if (forInstall) {
    const result = await api.showDialog(
      "question",
      "Manage game",
      {
        text: 'Switch to "{{gameName}}" to finish setup? Your downloaded archive will be available in Downloads.',
        parameters: { gameName: game.name },
      },
      [{ label: "Cancel" }, { label: "Manage" }],
    );
    if (result.action !== "Manage") return false;
  }

  const profiles = api.getState().persistent.profiles;
  if (
    !Object.values(profiles).some((profile) => profile.gameId === gameId && !profile.pendingRemove)
  ) {
    return manageGameDiscovered(api, gameId);
  }
  await activateGame(api.store, gameId);
  const current = api.getState();
  const nextProfile = profileById(current, current.settings.profiles.nextProfileId);
  return nextProfile?.gameId === gameId && !nextProfile.pendingRemove;
}

function removeProfileImpl(api: IExtensionApi, profileId: string) {
  const { store } = api;
  const state = api.getState();
  const { profiles } = state.persistent;
  log("info", "user removing profile", { id: profileId });

  if (profiles[profileId] === undefined) {
    // nothing to do
    return PromiseBB.resolve();
  }

  const currentProfile = activeProfile(state);

  store.dispatch(willRemoveProfile(profileId));
  if (profileId === currentProfile?.id) {
    store.dispatch(setNextProfile(undefined));
  }

  return fs
    .removeAsync(profilePath(profiles[profileId]))
    .catch((err) => (err.code === "ENOENT" ? PromiseBB.resolve() : PromiseBB.reject(err)))
    .then(() => {
      const gameMode = profiles[profileId].gameId;
      const lastProfileId = lastActiveProfileForGame(api.getState(), gameMode);
      if (profileId === lastProfileId) {
        store.dispatch(clearLastActiveProfile(gameMode));
      }
      store.dispatch(removeProfile(profileId));
    })
    .catch((err) => {
      const remaining = api.getState().persistent.profiles[profileId];
      if (remaining !== undefined) {
        store.dispatch(setProfile({ ...remaining, pendingRemove: false }));
      }
      api.showErrorNotification("Failed to remove profile", err, {
        allowReport: err.code !== "EPERM",
      });
    });
}

function removeMod(api: IExtensionApi, gameId: string, modId: string): PromiseBB<void> {
  return new PromiseBB((resolve, reject) => {
    api.events.emit(
      "remove-mod",
      gameId,
      modId,
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      },
      { reason: "stop_managing_game" },
    );
  });
}

function unmanageGame(api: IExtensionApi, gameId: string, gameName?: string): PromiseBB<void> {
  const state = api.getState();
  const game = getGame(gameId);
  const { mods, profiles } = state.persistent;
  const profileIds = Object.keys(profiles).filter(
    (profileId) => profiles[profileId]?.gameId === gameId,
  );

  api.events.emit("analytics-track-event", "Games", "Stop managing", gameId);

  let message: string;

  if (profileIds.length > 1 || profiles[profileIds[0]]?.name !== "Default") {
    message = profileIds.map((id) => profiles[id]?.name || id).join("\n");
  }

  return api
    .showDialog(
      "info",
      "Confirm Removal",
      {
        bbcode:
          "This will uninstall all mods managed by vortex and delete all profiles " +
          'for "{{gameName}}", ' +
          "potentially including associated savegames, ini files and everything else Vortex " +
          "stores per-profile." +
          "[br][/br][br][/br]" +
          "[style=dialog-danger-text]This is irreversible and we will not warn again, continue only if " +
          "you're sure this is what you want![/style]",
        message,
        parameters: {
          gameName: game?.name ?? gameName ?? String(api.translate("<Missing game>")),
        },
      },
      [{ label: "Cancel" }, { label: "Delete profiles" }],
    )
    .then((result) => {
      if (result.action === "Delete profiles") {
        return purgeMods(api, gameId, true)
          .then(() =>
            PromiseBB.map(Object.keys(mods[gameId] ?? {}), (modId) =>
              removeMod(api, gameId, modId),
            ),
          )
          .then(() => PromiseBB.map(profileIds, (profileId) => removeProfileImpl(api, profileId)))
          .then(() => {
            emitGameUnmanaged(api, gameId);
          })
          .catch((err) => {
            if (err instanceof UserCanceled) {
              return PromiseBB.resolve();
            }
            throw err;
          })
          .catch((err) => {
            const isSetupError = err instanceof NoDeployment || err instanceof TemporaryError;
            if (isSetupError) {
              api.showDialog(
                "error",
                "Failed to purge",
                {
                  text:
                    "Failed to purge mods deployed for this game. To ensure there are no " +
                    "leftovers before Vortex stops managing the game, please solve any " +
                    "setup problems for the game first.",
                },
                [{ label: "Close" }],
              );
              return;
            } else {
              api.showErrorNotification("Failed to stop managing game", err, {
                allowReport: !(err instanceof ProcessCanceled),
              });
            }
          });
      } else {
        return PromiseBB.resolve();
      }
    });
}

function addDescriptionFeature() {
  profileFeatures.push({
    id: "profile-description",
    type: "text",
    icon: "edit",
    label: "Description",
    description: "Describe your profile",
    supported: () => true,
    namespace: "default",
  });
}

function checkOverridden(api: IExtensionApi, gameId: string): PromiseBB<void> {
  const state = api.getState();
  const { disabled } = state.session.gameMode;

  if (disabled?.[gameId] === undefined) {
    return PromiseBB.resolve();
  }

  return api
    .showDialog(
      "question",
      "Game disabled",
      {
        text: "A different game extension is currently managing that game directory.",
        message: gameById(state, disabled[gameId])?.name ?? disabled[gameId],
      },
      [{ label: "Cancel" }],
    )
    .then(() => PromiseBB.reject(new UserCanceled()));
}

function init(context: IExtensionContext): boolean {
  const managingGames = new Map<string, Promise<boolean>>();
  const startManaging = (gameId: string, forInstall = false): Promise<boolean> => {
    const pending = managingGames.get(gameId);
    if (pending !== undefined) return pending;

    const operation = manageGame(context.api, gameId, forInstall)
      .catch((err) => {
        if (!(err instanceof UserCanceled)) {
          const allowReport =
            !(err instanceof ProcessCanceled) && !(err instanceof ServiceTemporarilyUnavailable);
          context.api.showErrorNotification("Failed to manage game", err, { allowReport });
        }
        return false;
      })
      .finally(() => managingGames.delete(gameId));
    managingGames.set(gameId, operation);
    return operation;
  };

  context.registerReducer(["persistent", "profiles"], profilesReducer);
  context.registerReducer(["settings", "profiles"], settingsReducer);
  context.registerReducer(["session", "profileTransfer"], transferSetupReducer);

  context.registerMainPage("profile", "Profiles", ProfileView, {
    hotkey: "P",
    group: "global",
    isClassicOnly: true,
    visible: () =>
      activeGameId(context.api.store.getState()) !== undefined &&
      context.api.store.getState().settings.interface.profilesVisible,
    props: () => ({ features: profileFeatures }),
  });

  context.registerMainPage("profile", "Profiles", ProfileView, {
    priority: 70,
    id: "game-profiles",
    hotkey: "P",
    group: "per-game",
    isModernOnly: true,
    visible: () =>
      activeGameId(context.api.store.getState()) !== undefined &&
      context.api.store.getState().settings.interface.profilesVisible,
    props: () => ({ features: profileFeatures }),
  });

  context.registerAction(
    "game-unmanaged-buttons",
    50,
    "activate",
    {
      noCollapse: true,
    },
    "Manage",
    (instanceIds: string[]) => {
      const gameId = instanceIds[0];

      context.api.events.emit("analytics-track-event", "Games", "Start managing", gameId);

      void startManaging(gameId);
    },
  );

  context.registerAction(
    "game-managed-buttons",
    50,
    "activate",
    {
      noCollapse: true,
    },
    "Activate",
    (instanceIds: string[]) => {
      const gameId = instanceIds[0];
      const state = context.api.getState();

      let gameVersion = "";
      let extensionVersion = "";
      let gameProfileCount = 1;

      if (gameId) {
        const game = getGame(gameId);
        extensionVersion = game.version;
        game.getInstalledVersion(discoveryByGame(state, gameId)).then((value) => {
          gameVersion = value;
        });
        gameProfileCount = Object.values(state.persistent.profiles).filter((profile) => {
          return profile.gameId === gameId;
        }).length;
      }

      const profileData = {
        gameId: gameId,
        gameVersion: gameVersion,
        extensionVersion: extensionVersion,
        gameProfileCount: gameProfileCount,
      };

      log("info", "activate profile", profileData);

      context.api.events.emit("analytics-track-event", "Games", "Activate", gameId, profileData);

      checkOverridden(context.api, gameId)
        .then(() => {
          activateGame(context.api.store, gameId);
        })
        .catch((err) => {
          if (!(err instanceof UserCanceled)) {
            context.api.showErrorNotification("Failed to activate game", err);
          }
        });
    },
    (instanceIds: string[]) => activeGameId(context.api.getState()) !== instanceIds[0],
  );

  context.registerProfileFile = (
    gameId: string,
    filePath: string | (() => PromiseLike<string[]>),
  ) => {
    if (profileFiles[gameId] === undefined) {
      profileFiles[gameId] = [];
    }
    profileFiles[gameId].push(filePath);
  };

  context.registerAction(
    "game-managed-buttons",
    150,
    "delete",
    {},
    context.api.translate("Stop Managing"),
    (instanceIds: string[]) => {
      unmanageGame(context.api, instanceIds[0]);
    },
  );

  context.registerProfileFeature = (
    featureId: string,
    type: string,
    icon: string,
    label: string,
    description: string,
    supported: () => boolean,
    extPath?: string,
    extInfo?: Partial<IRegisteredExtension>,
  ) => {
    profileFeatures.push({
      id: featureId,
      type,
      icon,
      label,
      description,
      supported,
      namespace: extInfo?.namespace,
    });
  };

  context.registerActionCheck("SET_NEXT_PROFILE", (state: IState, action: any) => {
    const { profileId } = action.payload;
    // Only clear notifications on a real transition between two
    // different profiles. Startup restores SET_NEXT_PROFILE from
    // undefined, and re-activation targets the current profile; both
    // would otherwise wipe warnings the user hasn't yet seen.
    const activeProfileId = state.settings.profiles.activeProfileId;
    if (profileId !== undefined && activeProfileId !== undefined && activeProfileId !== profileId) {
      context.api.dismissAllNotifications();
    }
    if (profileId === undefined) {
      // resetting must always work
      return undefined;
    }

    const profile = state.persistent.profiles[profileId];
    if (profile === undefined) {
      return "Tried to activate unknown profile";
    }

    if (
      getSafe(state, ["settings", "gameMode", "discovered", profile.gameId, "path"], undefined) ===
      undefined
    ) {
      return "Can't enable profile because game wasn't discovered";
    }

    return undefined;
  });

  context.registerAPI(
    "unmanageGame",
    (gameId: string, gameName?: string) => unmanageGame(context.api, gameId, gameName),
    {},
  );

  // ensure the current profile is always set to a valid value on startup and
  // when changing the game mode
  context.once(() => {
    const store = context.api.store;

    addDescriptionFeature();

    context.api.onAsync("manage-game-for-install", (gameId) => startManaging(gameId, true));

    context.api.events.on("activate-game", (gameId: string) => {
      activateGame(store, gameId);
    });

    // promise used to ensure a new profile switch can't be started before the last one
    // is complete
    let finishProfileSwitch: () => void;
    const startupSync = PromiseBB.defer<void>();

    context.api.onStateChange(
      ["settings", "profiles", "nextProfileId"],
      genOnProfileChange(
        context.api,
        (callback: () => void) => (finishProfileSwitch = callback),
        startupSync.promise,
      ),
    );

    context.api.onStateChange(
      ["settings", "profiles", "activeProfileId"],
      (prev: string, current: string) => {
        context.api.events.emit("profile-did-change", current);
        if (finishProfileSwitch !== undefined) {
          finishProfileSwitch();
        }
      },
    );

    context.api.onStateChange(
      ["persistent", "profiles"],
      (prev: { [profileId: string]: IProfile }, current: { [profileId: string]: IProfile }) => {
        Object.keys(current).forEach((profileId) => {
          if (prev[profileId] === current[profileId]) {
            return;
          }

          const profile = current[profileId];

          const prevState = getSafe(prev, [profileId, "modState"], {});
          const currentState = getSafe(current, [profileId, "modState"], {});

          if (prevState !== currentState) {
            const mods = context.api.getState().persistent.mods[profile.gameId];
            Object.keys(currentState).forEach((modId) => {
              const isEnabled = getSafe(currentState, [modId, "enabled"], false);
              const wasEnabled = getSafe(prevState, [modId, "enabled"], false);

              if (isEnabled !== wasEnabled && mods[modId] !== undefined) {
                context.api.events.emit(
                  isEnabled ? "mod-enabled" : "mod-disabled",
                  profileId,
                  modId,
                );
              }
            });
          }
        });
      },
    );
    {
      const state: IState = store.getState();

      const initProfile = activeProfile(state);
      refreshProfile(store, initProfile, "import")
        .then(() => {
          const { commandLine } = state.session.base;
          if (
            initProfile !== undefined &&
            commandLine?.profile === undefined &&
            commandLine?.game === undefined
          ) {
            // Re-read state: gamemode_management's startup discovery pass
            // (startQuickDiscovery → removeDisappearedGames) runs in parallel
            // and may have just cleared the active game's discovery if its
            // folder is no longer on disk. Emitting profile-did-change for a
            // game with no discovery causes downstream handlers to call into
            // path.join(undefined, ...). The manual-switch path already
            // refuses this state in genOnProfileChange; do the same here.
            const currentState: IState = store.getState();
            if (
              currentState.settings.profiles.activeProfileId !== initProfile.id ||
              currentState.settings.profiles.nextProfileId !== initProfile.id
            ) {
              return null;
            }
            const discovery = currentState.settings.gameMode.discovered[initProfile.gameId];
            if (discovery?.path === undefined) {
              showError(
                store.dispatch,
                "Game is no longer discoverable, please go to the games page and scan for, or " +
                  "manually select the game folder.",
                initProfile.gameId,
                { allowReport: false },
              );
              store.dispatch(setCurrentProfile(undefined, undefined));
              store.dispatch(setNextProfile(undefined));
              if (finishProfileSwitch !== undefined) {
                finishProfileSwitch();
              }
              return null;
            }
            context.api.events.emit("profile-did-change", initProfile.id);
          }
          return null;
        })
        .catch((err: Error) => {
          if (!(err instanceof UserCanceled)) {
            const allowReport = !(err instanceof CorruptActiveProfile);
            showError(store.dispatch, "Failed to set profile", err, {
              allowReport,
            });
          }
          const currentState: IState = store.getState();
          const owner = currentState.persistent.profiles[initProfile?.id];
          const validOwner =
            !(err instanceof CorruptActiveProfile) &&
            owner?.gameId !== undefined &&
            owner.gameId === initProfile?.gameId &&
            owner.pendingRemove !== true;
          if (validOwner) {
            if (currentState.settings.profiles.activeProfileId === owner.id) {
              store.dispatch(setNextProfile(owner.id));
            }
          } else {
            store.dispatch(setCurrentProfile(undefined, undefined));
            store.dispatch(setNextProfile(undefined));
            if (finishProfileSwitch !== undefined) {
              finishProfileSwitch();
            }
          }
        })
        .finally(() => startupSync.resolve());

      const { activeProfileId, nextProfileId } = state.settings.profiles;
      if (nextProfileId !== activeProfileId) {
        log("warn", "started with a profile change in progress");

        // ensure the new profile is valid and the corresponding game is
        // discovered
        if (truthy(activeProfileId) && state.persistent.profiles[activeProfileId] !== undefined) {
          const profile = state.persistent.profiles[activeProfileId];
          const discovery = discoveryByGame(state, profile.gameId);
          if (discovery?.path !== undefined) {
            store.dispatch(setNextProfile(activeProfileId));
          } else {
            store.dispatch(setNextProfile(undefined));
          }
        } else {
          store.dispatch(setNextProfile(undefined));
        }
      }

      // it's important we stop managing a game if it's no longer discovered
      // because that can cause problems all over the application
      if (truthy(activeProfileId)) {
        const profile = state.persistent.profiles[activeProfileId];
        const discovery = state.settings.gameMode.discovered[profile?.gameId];
        if (profile !== undefined && discovery?.path === undefined) {
          log("info", "active game no longer discovered, deactivate");
          store.dispatch(setNextProfile(undefined));
        }
      }
    }

    // Handle --profile and --game command line arguments.
    // This runs directly in once() rather than via onStateChange because
    // gamemode_management's once() (which dispatches setKnownGames) runs
    // before profile_management's once(), so the state change would be missed.
    // But the data we need from the state (the known games and the command line arguments)
    // Should be available by the time this runs.
    {
      const state: IState = store.getState();
      const { commandLine } = state.session.base;
      const known: IGameStored[] = state.session.gameMode.known;
      if (commandLine.profile !== undefined) {
        const profile: IProfile = getSafe(
          state,
          ["persistent", "profiles", commandLine.profile],
          undefined,
        );

        if (profile !== undefined) {
          context.api.store.dispatch(setNextProfile(profile.id));
        } else {
          log(
            "warn",
            "profile cmdline argument detected - but profile is missing",
            commandLine.profile,
          );
        }
      } else if (commandLine.game !== undefined) {
        // the game specified on the command line may be a game id or an extension
        // name, because at the time we download an extension we don't actually know
        // the game id yet.

        const extState = context.api.getState().app.extensions ?? {};
        const extPathLookup = Object.values(extState).reduce((prevExt, ext) => {
          prevExt[ext.path] = ext.name;
          return prevExt;
        }, {});

        const providers = known.filter(
          (iter) => extPathLookup[iter.extensionPath] === commandLine.game,
        );
        const aliases = known.filter(
          (iter) =>
            iter.details?.nexusPageId === commandLine.game ||
            iter.details?.nxmLinkId === commandLine.game,
        );
        const game =
          known.find((iter) => iter.id === commandLine.game) ??
          (aliases.length === 1 ? aliases[0] : undefined) ??
          (providers.length === 1 ? providers[0] : undefined);

        if (game !== undefined) {
          // Wait for discovery to populate before deciding undiscovered vs
          // discovered; otherwise this races the fire-and-forget
          // startQuickDiscovery in gamemode_management.once() and pops the
          // "Game not discovered" dialog even though discovery would have
          // succeeded.
          void startManaging(game.id);
        } else {
          context.api.sendNotification({
            type: "warning",
            title: "Game setup incomplete",
            message:
              'Open Games and select Manage for the intended game. The requested game "{{game}}" could not be identified.',
            replace: { game: commandLine.game },
          });
          log("warn", "game specified on command line could not be identified", {
            game: commandLine.game,
          });
        }
      }
    }
  });

  context.registerDialog("profile-transfer-connector", Connector);
  context.registerDialog("transfer-dialog-settings", TransferDialog);

  return true;
}

export default init;
