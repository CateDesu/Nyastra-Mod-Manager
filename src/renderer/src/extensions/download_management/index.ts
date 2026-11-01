import { spawn } from "child_process";
import type { Stats } from "node:fs";
import { copyFile, link, lstat, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import * as path from "path";

import { mdiDownload } from "@mdi/js";
import {
  getErrorCode,
  getErrorMessageOrDefault,
  unknownToError,
  VortexError,
} from "@vortex/shared";
import PromiseBB from "bluebird";
import * as _ from "lodash";
import Zip from "node-7z";
import type * as Redux from "redux";
import { generate as shortid } from "shortid";

import { log } from "../../logging";
import ReduxProp from "../../ReduxProp";
import type { IExtensionApi, IExtensionContext } from "../../types/IExtensionContext";
import type { IState } from "../../types/IState";
import type { ITestResult } from "../../types/ITestResult";
import { fileMD5 } from "../../util/checksum";
import {
  DataInvalid,
  ProcessCanceled,
  SelfCopyCheckError,
  UserCanceled,
} from "../../util/CustomErrors";
import Debouncer from "../../util/Debouncer";
import { setErrorContext } from "../../util/errorHandling";
import { folderIsMissing } from "../../util/folderIsMissing";
import * as fs from "../../util/fs";
import type { Normalize } from "../../util/getNormalizeFunc";
import getNormalizeFunc from "../../util/getNormalizeFunc";
import { isWinePrefixPath, resolveWinePath } from "../../util/resolvePathCase";
import * as selectors from "../../util/selectors";
import { knownGames } from "../../util/selectors";
import { getSafe } from "../../util/storeHelper";
import { cleanFailedStagingTransfer } from "../../util/transferPath";
import { batchDispatch, toPromise, truthy } from "../../util/util";
import { convertGameIdReverse } from "../nexus_integration/util/convertGameId";
import {
  addLocalDownload,
  downloadProgress,
  removeDownload,
  removeDownloadSilent,
  setDownloadHash,
  setDownloadHashAndSize,
  setDownloadModInfo,
} from "./actions/state";
import { setTransferDownloads } from "./actions/transactions";
import downloadAttributes from "./downloadAttributes";
import { settingsReducer } from "./reducers/settings";
import { stateReducer } from "./reducers/state";
import { transactionsReducer } from "./reducers/transactions";
import type { DownloadState, IDownload } from "./types/IDownload";
import {
  archiveOwners,
  downloadArchivePath,
  MANAGED_ARCHIVE_KEY,
  physicalArchivePath,
  withArchiveMutation,
  removeArchiveFile,
} from "./util/archiveOwnership";
import { ensureDownloadsDirectory } from "./util/downloadDirectory";
import { isTempDownloadName, TEMP_DOWNLOAD_PREFIX } from "./util/downloadNames";
import extendAPI from "./util/extendApi";
import getDownloadGames from "./util/getDownloadGames";
import getDownloadPath from "./util/getDownloadPath";
import { finalizeDownload } from "./util/postprocessDownload";
import queryInfo from "./util/queryDLInfo";
import { refreshDownloads } from "./util/refreshDownloads";
import setDownloadGames, { trackDownloadRelocations } from "./util/setDownloadGames";
import { startDownloadFromURL } from "./util/startDownloadFromURL";
import type { IDownloadViewProps } from "./views/DownloadView";
import DownloadView from "./views/DownloadView";
import Settings from "./views/Settings";
import ShutdownButton from "./views/ShutdownButton";
import SpeedOMeter from "./views/SpeedOMeter";

declare module "../../types/IExtensionContext" {
  interface ApiEvents {
    "set-download-games": (dlId: string, gameIds: string[], fromMetadata?: boolean) => void;
  }
}

let updateDebouncer: Debouncer;

import { knownArchiveExt } from "../../util/archives";

const addLocalInProgress = new Set<string>();
const localImportQueues = new Map<string, Promise<unknown>>();

async function queueLocalImport(
  destination: string,
  run: () => PromiseLike<string>,
): Promise<string> {
  const resolved = await resolveWinePath(destination);
  let directory = path.dirname(resolved);
  try {
    directory = await realpath(directory);
  } catch (err) {
    if (getErrorCode(err) !== "ENOENT") throw err;
  }
  const canonical = path.join(directory, path.basename(resolved));
  const key = isWinePrefixPath(resolved) ? canonical.toLowerCase() : canonical;
  const previous = localImportQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  localImportQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (localImportQueues.get(key) === current) localImportQueues.delete(key);
  }
}

function withAddInProgress(fileName: string, cb: () => PromiseLike<void>): PromiseLike<void> {
  addLocalInProgress.add(fileName);
  return PromiseBB.resolve(cb()).finally(() => {
    addLocalInProgress.delete(fileName);
  });
}

function attributeExtractor(input: any) {
  let downloadGame: string | string[] = getSafe(input, ["download", "game"], []);
  if (Array.isArray(downloadGame)) {
    downloadGame = downloadGame[0];
  }
  const logicalFileName = input?.meta?.logicalFileName || input?.download?.modInfo?.name;
  return PromiseBB.resolve({
    fileName: getSafe(input, ["download", "localPath"], undefined),
    fileMD5: getSafe(input, ["download", "fileMD5"], undefined),
    fileSize: getSafe(input, ["download", "size"], undefined),
    source: getSafe(input, ["download", "modInfo", "source"], undefined),
    version:
      getSafe(input, ["download", "modInfo", "version"], undefined) ??
      getSafe(input, ["download", "modInfo", "meta", "fileVersion"], undefined),
    logicalFileName,
    modId: getSafe(input, ["download", "modInfo", "ids", "modId"], undefined),
    fileId: getSafe(input, ["download", "modInfo", "ids", "fileId"], undefined),
    downloadGame,
  });
}

function attributeExtractorCustom(input: any) {
  return PromiseBB.resolve(input.download?.modInfo?.custom || {});
}

function genDownloadChangeHandler(
  api: IExtensionApi,
  currentDownloadPath: string,
  gameId: string,
  nameIdMap: { [name: string]: string },
  normalize: Normalize,
  isCurrent: () => boolean,
) {
  const updateTimers: { [fileName: string]: NodeJS.Timeout } = {};

  const store: Redux.Store<any> = api.store;

  const findDownload = (fileName: string): string => {
    const state = store.getState();
    return Object.keys(state.persistent.downloads.files).find(
      (iterId) =>
        getDownloadGames(state.persistent.downloads.files[iterId])[0] === gameId &&
        state.persistent.downloads.files[iterId].localPath === fileName,
    );
  };

  return (evt: string, fileName: string) => {
    if (!isCurrent() || !watchEnabled || fileName === undefined || !knownArchiveExt(fileName)) {
      return;
    }

    if (evt === "update") {
      if (updateTimers[fileName] !== undefined) {
        clearTimeout(updateTimers[fileName]);
        setTimeout(() => {
          fs.statAsync(path.join(currentDownloadPath, fileName)).then((stats) => {
            if (!isCurrent()) return;
            const dlId = findDownload(fileName);
            if (dlId !== undefined) {
              store.dispatch(downloadProgress(dlId, stats.size, stats.size, undefined));
            }
          });
        }, 1000);
      }
    } else if (evt === "rename") {
      if (addLocalInProgress.has(fileName)) {
        return;
      }
      // this delay is intended to prevent this from picking up files that Vortex added itself.
      // It is not enough however to prevent this from getting the wrong file size if the file
      // copy/write takes more than this one second.
      PromiseBB.delay(1000)
        .then(() => fs.statAsync(path.join(currentDownloadPath, fileName)))
        .then((stats) => {
          if (!isCurrent()) return;
          let dlId = findDownload(fileName);
          if (dlId === undefined) {
            dlId = shortid();
            log("debug", "file added to download directory at runtime", fileName);
            store.dispatch(addLocalDownload(dlId, gameId, fileName, stats.size));
            api.events.emit("did-import-downloads", [dlId]);
          }
          nameIdMap[normalize(fileName)] = dlId;
        })
        .catch((err) => {
          if (!isCurrent()) return;
          const normName = normalize(fileName);
          // in the past we used the nameIdMap to resolve the download id but that is
          // probably an unnecessary optimization that may just lead to errors
          if (err.code === "ENOENT") {
            // if the file was deleted, remove it from state. This does nothing if
            // the download was already removed so that's fine
            const dlId = findDownload(fileName);
            if (dlId !== undefined) {
              store.dispatch(removeDownload(dlId));
            }
            delete nameIdMap[normName];
          }
        });
    }
  };
}

let currentWatch: fs.FSWatcher;
let watchEnabled: boolean = true;
let watchGeneration = 0;
let watchStore: IExtensionApi["store"];
const downloadMoves = new Set<object>();

function invalidateDownloadWatch() {
  ++watchGeneration;
  currentWatch?.close();
  currentWatch = undefined;
}

function watchDownloads(
  api: IExtensionApi,
  downloadPath: string,
  onChange: (evt: string, fileName: string) => void,
) {
  if (currentWatch !== undefined) {
    currentWatch.close();
  }

  try {
    currentWatch = fs.watch(downloadPath, {}, onChange);
    currentWatch.on("error", (error) => {
      // these may happen when the download path gets moved.
      log("warn", "failed to watch mod directory", { downloadPath, error });
    });
  } catch (err) {
    api.showErrorNotification("Can't watch the download directory for changes", err, {
      allowReport: false,
    });
  }
}

async function removeInvalidDownloads(api: IExtensionApi, gameId?: string) {
  const state: IState = api.store.getState();
  gameId = gameId || selectors.activeGameId(state);
  if (!gameId) {
    return;
  }
  const downloadPath = selectors.downloadPathForGame(state, gameId);
  const downloads: { [id: string]: IDownload } = state.persistent.downloads.files;
  if (await folderIsMissing(downloadPath)) {
    return;
  }
  const gameDownloads = Object.keys(downloads).filter(
    (dlId) => getDownloadGames(downloads[dlId])[0] === gameId,
  );

  const incomplete = gameDownloads.filter(
    (dlId) =>
      ["finished", "paused", "failed"].includes(downloads[dlId].state) &&
      (!downloads[dlId].localPath || downloads[dlId].received === 0 || downloads[dlId].size === 0),
  );
  const invalid = gameDownloads.filter(
    (dlId) =>
      ["finished", "failed"].includes(downloads[dlId].state) &&
      downloads[dlId].localPath &&
      !path.extname(downloads[dlId].localPath),
  );
  const removeSet = new Set<string>(incomplete.concat(invalid));

  const toRemove: string[] = [];
  const repairActions: Array<ReturnType<typeof downloadProgress>> = [];

  await Promise.all(
    Array.from(removeSet).map(async (dlId) => {
      if (downloads[dlId].localPath === undefined) {
        toRemove.push(dlId);
        return;
      }
      const filePath = path.join(downloadPath, downloads[dlId].localPath);
      const stats = await fs.statAsync(filePath).catch((err: unknown) => {
        if (getErrorCode(err) === "ENOENT") {
          return undefined;
        }
        throw err;
      });
      if (stats?.size > 0) {
        // file exists and is valid on disk - repair the state instead of deleting
        repairActions.push(downloadProgress(dlId, stats.size, stats.size, undefined));
      } else {
        // file genuinely missing or empty - safe to clean up
        await fs.removeAsync(filePath).catch(() => null);
        toRemove.push(dlId);
      }
    }),
  );
  batchDispatch(api.store, [
    ...repairActions,
    ...toRemove.map((dlId) => removeDownloadSilent(dlId)),
  ]);
}

function removeInvalidFileExts(api: IExtensionApi, gameId?: string) {
  const state: IState = api.store.getState();
  gameId = gameId || selectors.activeGameId(state);
  if (!gameId) {
    return PromiseBB.resolve();
  }
  const downloadPath = selectors.downloadPathForGame(state, gameId);
  return fs
    .readdirAsync(downloadPath)
    .then((files: string[]) => {
      return PromiseBB.all(
        files.map((fileName) => {
          if (!knownArchiveExt(fileName) && !isTempDownloadName(fileName)) {
            return fs.removeAsync(path.join(downloadPath, fileName)).catch(() => null);
          }
        }),
      );
    })
    .catch((err) =>
      ["ENOENT", "EACCES", "EPERM"].includes(err.code)
        ? null
        : log("warn", "failed to remove invalid download files", err),
    );
}

function updateDownloadPath(api: IExtensionApi, gameId?: string) {
  if (api.store !== watchStore) return PromiseBB.resolve();
  const generation = watchGeneration;
  return PromiseBB.resolve(
    withArchiveMutation(api, () => updateDownloadPathNow(api, gameId, generation)),
  ).then(() => undefined);
}

function updateDownloadPathNow(api: IExtensionApi, gameId: string | undefined, generation: number) {
  if (downloadMoves.size > 0 || generation !== watchGeneration) return PromiseBB.resolve();
  const state: IState = api.store.getState();
  if (gameId === undefined) {
    gameId = selectors.activeGameId(state);
    if (gameId === undefined) {
      return PromiseBB.resolve();
    }
  }
  const currentDownloadPath = selectors.downloadPathForGame(state, gameId);
  const isCurrent = () =>
    generation === watchGeneration &&
    downloadMoves.size === 0 &&
    selectors.downloadPathForGame(api.getState(), gameId) === currentDownloadPath;
  const isSelected = () => isCurrent() && selectors.activeGameId(api.getState()) === gameId;

  let nameIdMap: { [name: string]: string } = {};
  // dlId -> download record
  let downloads: Record<string, IDownload> = {};
  let downloadChangeHandler: (evt: string, fileName: string) => void;
  // when the folder turns out to be unavailable nothing gets reconciled, so
  // there is also nothing to watch and no refresh to announce
  let folderAvailable = true;
  return (removeInvalidDownloads(api, gameId) as any)
    .then(() => removeInvalidFileExts(api, gameId))
    .then(() =>
      getNormalizeFunc(currentDownloadPath, {
        separators: false,
        relative: false,
      }),
    )
    .then((normalize) => {
      downloads = api.getState().persistent.downloads.files;
      nameIdMap = Object.keys(downloads).reduce((prev, value) => {
        if (
          getDownloadGames(downloads[value])[0] === gameId &&
          downloads[value].localPath !== undefined
        ) {
          prev[normalize(downloads[value].localPath)] = value;
        }
        return prev;
      }, {});

      downloadChangeHandler = genDownloadChangeHandler(
        api,
        currentDownloadPath,
        gameId,
        nameIdMap,
        normalize,
        isSelected,
      );

      // Get the downloads for this game, but only the ones that
      // have a valid localPath.
      const knownDLs = Object.keys(downloads)
        .filter(
          (dlId) =>
            getDownloadGames(downloads[dlId])[0] === gameId &&
            downloads[dlId].localPath !== undefined &&
            !isTempDownloadName(downloads[dlId].localPath),
        )
        .map((dlId) => normalize(downloads[dlId].localPath || ""));

      return refreshDownloads(
        currentDownloadPath,
        knownDLs,
        normalize,
        (fileName: string) =>
          fs.statAsync(path.join(currentDownloadPath, fileName)).then((stats: fs.Stats) => {
            if (!isCurrent()) return;
            const dlId = shortid();
            log("debug", "registering previously unknown archive", fileName);
            api.store.dispatch(addLocalDownload(dlId, gameId, fileName, stats.size));
            nameIdMap[normalize(fileName)] = dlId;
          }),
        (fileName: string) => {
          // the fileName here is already normalized
          if (isCurrent()) api.store.dispatch(removeDownload(nameIdMap[fileName]));
          return PromiseBB.resolve();
        },
        () =>
          new PromiseBB((resolve, reject) => {
            api.showDialog(
              "question",
              "Access Denied",
              {
                text:
                  "The download directory is not writable to your user account.\n" +
                  "If you have admin rights on this system, Vortex can change the permissions " +
                  "to allow it write access.",
              },
              [
                { label: "Cancel", action: () => reject(new UserCanceled()) },
                { label: "Allow access", action: () => resolve() },
              ],
            );
          }),
      ).catch((err: unknown) => {
        if (err instanceof UserCanceled) {
          return null;
        }
        if (err instanceof VortexError && err.data.kind === "fs:not-found") {
          // reconciling against a folder Vortex can't see would delete every
          // download record for this game, so reconciliation is skipped
          folderAvailable = false;
          api.showErrorNotification(
            "Download folder is not available",
            getErrorMessageOrDefault(err),
            { allowReport: false },
          );
          return null;
        }
        api.showErrorNotification("Failed to refresh download directory", err, {
          allowReport: getErrorCode(err) !== "EPERM",
        });
      });
    })
    .then(() => {
      if (!folderAvailable || !isSelected()) {
        return;
      }
      watchDownloads(api, currentDownloadPath, downloadChangeHandler);
      api.events.emit("downloads-refreshed");
    })
    .then(() => checkDownloadsWithMissingMeta(api))
    .catch((err) => {
      api.showErrorNotification("Failed to read downloads directory", err, {
        allowReport: err.code !== "ENOENT",
      });
    });
}

function testDownloadPath(api: IExtensionApi): PromiseBB<void> {
  return ensureDownloadsDirectory(api)
    .catch(ProcessCanceled, () => PromiseBB.resolve())
    .catch(UserCanceled, () => PromiseBB.resolve())
    .catch((err) => {
      const errTitle = err.code === "EPERM" ? "Insufficient permissions" : "Downloads folder error";

      return new PromiseBB<void>((resolve) => {
        api.showDialog(
          "error",
          errTitle,
          {
            text:
              "Unable to finalize downloads folder creation/transfer. Please ensure your OS " +
              "account has full read/write permissions for the target destination and try again. " +
              "An exception should be added to Anti-Virus apps for Vortex. (where applicable)",
            message: err.message,
          },
          [{ label: "Retry", action: () => resolve() }],
        );
      }).then(() => testDownloadPath(api));
    });
}

function genGameModeActivated(api: IExtensionApi) {
  return () => {
    invalidateDownloadWatch();
    return testDownloadPath(api).then(() => updateDebouncer.schedule());
  };
}

function removeArchiveRecords(
  store: Redux.Store<IState>,
  destination: string,
  gameId: string,
  importedId: string,
) {
  const state = store.getState();
  const fileName = path.basename(destination);
  const { files } = state.persistent.downloads;
  Object.keys(files)
    .filter(
      (dlId) =>
        dlId !== importedId &&
        getDownloadGames(files[dlId])[0] === gameId &&
        files[dlId].localPath === fileName,
    )
    .forEach((dlId) => {
      store.dispatch(removeDownload(dlId));
    });
}

function queryReplace(api: IExtensionApi, destination: string) {
  return api
    .showDialog(
      "question",
      "File exists",
      {
        text: "This file already exists, do you want to replace it?",
        message: destination,
      },
      [{ label: "Cancel" }, { label: "Replace" }],
    )
    .then((result) =>
      result.action === "Cancel" ? PromiseBB.reject(new UserCanceled()) : PromiseBB.resolve(),
    );
}

function processInstallError(
  api: IExtensionApi,
  error: any,
  downloadId: string,
  archiveName: string,
) {
  // This installation error handling function is intended to be used to
  //  handle installation errors that are obfuscated for some reason, and
  //  the installManager's error handling is not sufficient or is unable
  //  to relay certain pieces of information to the user.
  if (error instanceof DataInvalid) {
    const downloadExists = api.getState().persistent.downloads.files[downloadId] !== undefined;
    if (!downloadExists) {
      error["message"] =
        "Vortex attempted to install a mod archive which is no longer available " +
        "in its internal state - this usually happens if the archive was scheduled " +
        "to be installed but was removed before the installation was able to start.";
      error["archiveName"] = archiveName;
      api.showErrorNotification("Install Failed", error, {
        allowReport: false,
      });
    }
  }
}

function postImport(
  api: IExtensionApi,
  destination: string,
  fileSize: number,
  silent: boolean,
  gameMode: string,
  dlId = shortid(),
  retainOnError = false,
): PromiseBB<string> {
  const store = api.store;
  const fileName = path.basename(destination);

  log("debug", "import local download", destination);
  // do this after copy is completed, otherwise code watching for the event may be
  // trying to access the file already
  store.dispatch(addLocalDownload(dlId, gameMode, fileName, fileSize));
  return fs
    .statAsync(destination)
    .then((stats) => {
      store.dispatch(downloadProgress(dlId, stats.size, stats.size, undefined));
      return toPromise((cb) => api.events.emit("did-import-downloads", [dlId], cb));
    })
    .then(() => {
      if (store.getState().persistent.downloads.files[dlId] === undefined) {
        throw new ProcessCanceled("Imported archive was removed during registration");
      }
      if (!silent) {
        api.sendNotification({
          id: `ready-to-install-${dlId}`,
          type: "success",
          title: "File imported",
          group: "download-finished",
          message: fileName,
          actions: [
            {
              title: "Install All",
              action: (dismiss) => {
                api.events.emit("start-install-download", dlId, undefined, (err, mId) => {
                  if (err) {
                    processInstallError(api, err, dlId, fileName);
                  }
                });
                dismiss();
              },
            },
          ],
        });
      }

      return dlId;
    })
    .catch((err) => {
      if (!retainOnError) store.dispatch(removeDownload(dlId));
      log("info", "failed to copy", { error: err.message });
      return undefined;
    });
}

async function commitLocalImport(
  api: IExtensionApi,
  destination: string,
  silent: boolean,
  gameId: string,
  create: (staged: string) => PromiseLike<unknown>,
): Promise<string> {
  destination = await resolveWinePath(destination);
  const staging = await mkdtemp(path.join(path.dirname(destination), TEMP_DOWNLOAD_PREFIX));
  const staged = path.join(staging, path.basename(destination));
  const backup = path.join(staging, "previous");
  let backedUp = false;
  let managedBackup = false;
  let swapped = false;
  let retainBackup = false;
  const importedId = shortid();
  let stagedIdentity: Stats;
  let relocation: ReturnType<typeof trackDownloadRelocations> | undefined;
  try {
    await create(staged);
    stagedIdentity = await stat(staged);
    const size = stagedIdentity.size;
    const { registration } = await withArchiveMutation(api, async () => {
      try {
        managedBackup = (await lstat(destination)).isFile();
        try {
          await link(destination, backup);
        } catch (err) {
          if (!["EXDEV", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(getErrorCode(err))) {
            throw err;
          }
          await copyFile(destination, backup);
        }
        backedUp = true;
      } catch (err) {
        if (getErrorCode(err) !== "ENOENT") throw err;
      }
      await rename(staged, destination);
      swapped = true;
      relocation = trackDownloadRelocations(api, importedId, {
        path: await physicalArchivePath(destination),
        dev: stagedIdentity.dev,
        ino: stagedIdentity.ino,
        birthtimeMs: stagedIdentity.birthtimeMs,
        download: { game: [gameId], localPath: path.basename(destination) } as IDownload,
      });
      // Metadata listeners may move or remove this row. Release the mutation lock first.
      return { registration: postImport(api, destination, size, silent, gameId, importedId, true) };
    });
    if ((await registration) === undefined)
      throw new ProcessCanceled("Failed to register imported archive");
    return await withArchiveMutation(api, async () => {
      const imported = api.getState().persistent.downloads.files[importedId];
      if (imported === undefined) throw new ProcessCanceled("Failed to register imported archive");
      removeArchiveRecords(api.store, destination, gameId, importedId);
      if (
        getDownloadGames(imported)[0] !== gameId ||
        imported.localPath !== path.basename(destination)
      ) {
        await removeArchiveFile(api, importedId, {
          ...imported,
          game: [gameId],
          localPath: path.basename(destination),
        }).catch((err) =>
          log("warn", "failed to clean relocated import source", { destination, err }),
        );
      }
      return importedId;
    });
  } catch (err) {
    if (swapped) {
      try {
        await withArchiveMutation(api, async () => {
          try {
            for (const archive of relocation?.archives.slice(1) ?? []) {
              const current = await lstat(archive.path).catch((error) => {
                if (getErrorCode(error) === "ENOENT") return undefined;
                throw error;
              });
              if (
                current?.isFile() &&
                current.dev === archive.dev &&
                current.ino === archive.ino &&
                current.birthtimeMs === archive.birthtimeMs &&
                (await physicalArchivePath(
                  downloadArchivePath(api.getState(), archive.download),
                )) === archive.path
              ) {
                await removeArchiveFile(api, importedId, archive.download);
              }
            }
            const current = await lstat(destination).catch((error) => {
              if (getErrorCode(error) === "ENOENT") return undefined;
              throw error;
            });
            if (
              current !== undefined &&
              (current.dev !== stagedIdentity.dev ||
                current.ino !== stagedIdentity.ino ||
                current.birthtimeMs !== stagedIdentity.birthtimeMs)
            ) {
              throw new ProcessCanceled("Imported archive was replaced during registration");
            }
            if (backedUp) {
              const restored = await lstat(backup);
              await rename(backup, destination);
              if (managedBackup && restored.isFile()) {
                const identity = await physicalArchivePath(destination);
                const owners = await archiveOwners(api, importedId, identity);
                for (const { id, archivePath } of owners) {
                  if (!(await lstat(archivePath)).isSymbolicLink()) continue;
                  api.store.dispatch(
                    setDownloadModInfo(id, MANAGED_ARCHIVE_KEY, {
                      path: identity,
                      dev: restored.dev,
                      ino: restored.ino,
                      birthtimeMs: restored.birthtimeMs,
                    }),
                  );
                }
              }
            } else {
              await removeArchiveFile(api, importedId, {
                game: [gameId],
                localPath: path.basename(destination),
              } as IDownload);
            }
          } finally {
            api.store.dispatch(removeDownload(importedId));
          }
        });
      } catch (restoreError) {
        retainBackup = true;
        throw new AggregateError(
          [err, restoreError],
          `Import recovery failed, backup at ${backup}`,
          { cause: restoreError },
        );
      }
    }
    throw err;
  } finally {
    relocation?.stop();
    if (!retainBackup) {
      await rm(staging, { recursive: true, force: true }).catch((err) =>
        log("warn", "failed to clean import staging folder", { staging, err }),
      );
    }
  }
}

function move(
  api: IExtensionApi,
  source: string,
  destination: string,
  silent: boolean,
  gameId: string,
): PromiseBB<string> {
  const notiId = silent
    ? undefined
    : api.sendNotification({
        type: "activity",
        title: "Importing file",
        message: path.basename(destination),
      });
  let fileSize: number;
  const fileName = path.basename(destination);
  let resolvedDestination = destination;
  addLocalInProgress.add(fileName);
  return fs
    .statAsync(destination)
    .catch(() => undefined)
    .then((stats: fs.Stats) => {
      if (stats !== undefined) {
        fileSize = stats.size;
      }
      return PromiseBB.all([resolveWinePath(source), resolveWinePath(destination)])
        .then(([from, to]) => {
          resolvedDestination = to;
          return fs.selfCopyCheck(from, to);
        })
        .then(() => (stats !== undefined ? queryReplace(api, destination) : null));
    })
    .then(() =>
      commitLocalImport(api, resolvedDestination, silent, gameId, (staged) =>
        fs.copyAsync(source, staged, { dereference: true }),
      ),
    )
    .catch(SelfCopyCheckError, () => {
      const { files } = api.getState().persistent.downloads;
      const existing = Object.keys(files).find(
        (id) =>
          getDownloadGames(files[id])[0] === gameId &&
          files[id].localPath === path.basename(resolvedDestination),
      );
      return existing ?? postImport(api, resolvedDestination, fileSize, silent, gameId);
    })
    .catch((err) => {
      api.showErrorNotification("Import Failed", err, { allowReport: false });
      log("info", "failed to copy", { error: err.message });
      return undefined;
    })
    .finally(() => {
      if (notiId !== undefined) {
        api.dismissNotification(notiId);
      }
      addLocalInProgress.delete(fileName);
    });
}

function importDirectory(
  api: IExtensionApi,
  source: string,
  destination: string,
  silent: boolean,
  gameId: string,
) {
  const zipper = new Zip();

  const notiId = silent
    ? undefined
    : api.sendNotification({
        type: "activity",
        title: "Importing file",
        message: path.basename(destination),
      });

  const fileName = path.basename(destination);
  addLocalInProgress.add(fileName);

  return fs
    .statAsync(destination)
    .then(() => queryReplace(api, destination))
    .catch((err) => {
      if (getErrorCode(err) !== "ENOENT") throw err;
    })
    .then(() => resolveWinePath(source))
    .then((resolved) => fs.readdirAsync(resolved).then((files) => ({ resolved, files })))
    .then(({ resolved, files }) =>
      commitLocalImport(api, destination, silent, gameId, (staged) =>
        zipper.add(
          staged,
          files.map((name) => path.join(resolved, name)),
        ),
      ),
    )
    .catch((err) => {
      api.showErrorNotification("Import Failed", err, { allowReport: false });
      log("info", "failed to copy", { error: err.message });
      return undefined;
    })
    .finally(() => {
      if (notiId !== undefined) {
        api.dismissNotification(notiId);
      }
      addLocalInProgress.delete(fileName);
    });
}

function genImportDownloadsHandler(api: IExtensionApi) {
  return (downloadPaths: string[], cb?: (dlIds: string[]) => void, silent?: boolean) => {
    const state = api.getState();
    const gameMode = selectors.activeGameId(state);

    if (gameMode === undefined) {
      log("warn", "can't import download(s) when no game is active", downloadPaths);
      cb?.([]);
      return;
    }

    log("debug", "importing download(s)", downloadPaths);
    const downloadPath = selectors.downloadPathForGame(state, gameMode);
    PromiseBB.map(downloadPaths, (dlPath) => {
      const fileName = path.basename(dlPath);
      let destination = path.join(downloadPath, fileName);
      return fs
        .statAsync(dlPath)
        .then((stats: fs.Stats) => {
          if (stats.isDirectory()) {
            destination += ".7z";
            return queueLocalImport(destination, () =>
              importDirectory(api, dlPath, destination, silent ?? false, gameMode),
            );
          } else {
            return queueLocalImport(destination, () =>
              move(api, dlPath, destination, silent ?? false, gameMode),
            );
          }
        })
        .tap((dlId: string) => {
          log("info", "imported archives", { count: downloadPaths.length });
          return dlId;
        })
        .catch((err) => {
          api.sendNotification({
            type: "warning",
            title: err.code === "ENOENT" ? "File doesn't exist" : err.message,
            message: dlPath,
          });
        });
    }).then((dlIds: string[]) => {
      const files = api.getState().persistent.downloads.files;
      cb?.(dlIds.filter((id) => id !== undefined && files[id] !== undefined));
    });
  };
}

/**
 * Opens a url in the embedded browser and downloads whatever it resolves to. Pasted urls can't be
 * fetched reliably up front: some sites (mega.nz, google drive, ...) assemble the file client-side
 * and hand it over as a blob, others sit behind a challenge/login page. The browser resolves to
 * either a blob (the main process saves it to temp; the download adapter adopts it) or a direct
 * link; both are handed to start-download, which routes a blob to adoption and everything else to
 * the network downloader.
 */
async function browseAndDownload(
  api: IExtensionApi,
  navUrl: string,
  onComplete?: (err: Error | null, dlId?: string) => void,
): Promise<void> {
  const instructions = api.translate(
    "This site delivers the file through your browser. Start the download on the page and " +
      "Vortex will pick it up automatically.",
  );
  const results: string[] = await api.emitAndAwait("browse-for-download", navUrl, instructions);
  const raw = (results ?? []).find(truthy);
  // No/err result means the user closed or canceled the browser.
  if (raw === undefined || raw.startsWith("err:")) {
    return;
  }
  api.events.emit("start-download", [raw], {}, undefined, onComplete ?? (() => null));
}

function checkPendingTransfer(api: IExtensionApi): PromiseBB<ITestResult> {
  let result: ITestResult;
  const state = api.store.getState();

  const pendingTransfer: string[] = ["persistent", "transactions", "transfer", "downloads"];
  const transferDestination = getSafe(state, pendingTransfer, undefined);
  if (transferDestination === undefined) {
    return PromiseBB.resolve(result);
  }

  result = {
    severity: "warning",
    description: {
      short: "Folder transfer was interrupted",
      long:
        "An attempt to move the download folder was interrupted. You should let " +
        "Vortex clean up now, otherwise you may be left with unnecessary copies of files.",
    },
    automaticFix: () =>
      PromiseBB.try(async () => {
        const current = api.getState();
        if (getSafe(current, pendingTransfer, undefined) !== transferDestination) return;
        api.sendNotification({
          id: "transfer-cleanup",
          message: "Cleaning up interrupted transfer",
          type: "activity",
        });
        try {
          const source = getDownloadPath(current.settings.downloads.path);
          if (source !== transferDestination) {
            await cleanFailedStagingTransfer(source, transferDestination);
          }
          if (getSafe(api.getState(), pendingTransfer, undefined) === transferDestination) {
            api.store.dispatch(setTransferDownloads(undefined));
          }
        } finally {
          api.dismissNotification("transfer-cleanup");
        }
      }),
  };

  return PromiseBB.resolve(result);
}

let shutdownPending: boolean = false;
let shutdownInitiated: boolean = false;
let shutdownTimer: NodeJS.Timeout | undefined;

const SHUTDOWN_DELAY_SEC = 30;

function initiateShutdown() {
  shutdownTimer = setTimeout(() => {
    spawn("systemctl", ["poweroff"], { detached: true, stdio: "ignore" })
      .on("error", (err) => log("error", "failed to shut down", err.message))
      .unref();
  }, SHUTDOWN_DELAY_SEC * 1000);
}

function abortShutdown() {
  {
    clearTimeout(shutdownTimer);
  }
}

/**
 * schedule or abort shutdown as necessary. This gets called constantly as downloads
 * are happening, the shutdown is sheduled when there are no active downloads, it's
 * canceled when new downloads are started
 */
function updateShutdown(downloads: { [key: string]: IDownload }) {
  if (shutdownInitiated && (Object.keys(downloads).length > 0 || !shutdownPending)) {
    // cancel shutdown if the conditions for it are no longer met
    abortShutdown();
    shutdownInitiated = false;
  }

  if (!shutdownInitiated && shutdownPending && Object.keys(downloads).length === 0) {
    // schedule shutdown if conditions are met
    initiateShutdown();
    shutdownInitiated = true;
  }
}

function toggleShutdown(api: IExtensionApi) {
  if (shutdownPending) {
    shutdownPending = false;
    updateShutdown(selectors.activeDownloads(api.getState()));
  } else {
    api.showDialog(
      "question",
      "Confirm Shutdown",
      {
        text:
          "Your computer will be shut down 30 seconds after the last download finished. " +
          "Please make sure you've saved all your work in all running applications.\n" +
          "You can cancel this at any time by pressing the button again.",
      },
      [
        { label: "Cancel" },
        {
          label: "Schedule Shutdown",
          action: () => {
            shutdownPending = true;
            updateShutdown(selectors.activeDownloads(api.getState()));
          },
        },
      ],
    );
  }
}

function checkForUnfinalized(
  api: IExtensionApi,
  downloads: { [id: string]: IDownload },
  gameMode: string,
) {
  const unfinalized = Object.keys(downloads).filter(
    (id) =>
      (downloads[id].state === "finalizing" ||
        (downloads[id].state === "finished" && downloads[id].fileMD5 === undefined)) &&
      downloads[id].localPath !== undefined,
  );

  if (unfinalized.length > 0) {
    api.sendNotification({
      type: "error",
      title: "Some downloads were not finalized",
      message: "Vortex may appear frozen for a moment while repairing this.",
      actions: [
        {
          title: "Repair",
          action: (dismiss) => {
            dismiss();

            const notiId = shortid();
            let completed = 0;

            const progress = (title: string) => {
              api.sendNotification({
                id: notiId,
                type: "activity",
                title: "Finalizing downloads",
                message: title,
                progress: (completed * 100) / unfinalized.length,
              });
            };

            progress("...");

            PromiseBB.map(
              unfinalized,
              (id) => {
                const gameId = Array.isArray(downloads[id].game)
                  ? convertGameIdReverse(knownGames(api.getState()), downloads[id].game[0])
                  : gameMode;
                const downloadPath = selectors.downloadPathForGame(api.getState(), gameId);
                const filePath = path.join(downloadPath, downloads[id].localPath);
                progress(downloads[id].localPath);
                if (downloads[id].state === "finalizing") {
                  return finalizeDownload(api, id, filePath)
                    .catch((err) => {
                      log("warn", "failed to properly finalize download", {
                        fileName: downloads[id].localPath,
                        error: err.message,
                      });
                    })
                    .finally(() => ++completed);
                } else {
                  return fileMD5(filePath)
                    .then((md5sum) => {
                      api.store.dispatch(setDownloadHash(id, md5sum));
                    })
                    .catch((err: unknown) => {
                      if (getErrorCode(err) === "ENOENT") {
                        // file doesn't exist, remove invalid download entry
                        api.store.dispatch(removeDownload(id));
                      } else {
                        log("error", "failed to calculate hash for download", {
                          file: downloads[id].localPath,
                          error: getErrorMessageOrDefault(err),
                        });
                      }
                    })
                    .finally(() => ++completed);
                }
              },
              { concurrency: 4 },
            ).then(() => {
              api.dismissNotification(notiId);
            });
          },
        },
      ],
    });
  }
}

function removeDownloadsWithoutFile(store: Redux.Store, downloads: { [id: string]: IDownload }) {
  // remove downloads that have no localPath set because they just cause trouble. They shouldn't
  // exist at all
  Object.keys(downloads)
    .filter((dlId) => !truthy(downloads[dlId].localPath))
    .forEach((dlId) => {
      store.dispatch(removeDownloadSilent(dlId));
    });
}

function checkDownloadsWithMissingMeta(api: IExtensionApi) {
  const state = api.getState();
  const downloads = state.persistent.downloads.files ?? {};

  const missingInfo = Object.keys(downloads).filter(
    (dlId) => downloads[dlId].modInfo?.source === undefined,
  );

  if (missingInfo.length > 0) {
    log("info", "downloads missing meta information", { dlIds: missingInfo });
    queryInfo(api, missingInfo, false);
  } else {
    log("debug", "no missing meta information");
  }
}

function processCommandline(api: IExtensionApi) {
  const state = api.getState();

  const { commandLine } = state.session.base;

  const cliUrl = commandLine.download ?? commandLine.install;
  if (cliUrl) {
    api.events.emit("start-download-url", cliUrl, undefined, commandLine.install !== undefined);
  }

  const arcPath = commandLine.installArchive;
  if (typeof arcPath === "string" && path.isAbsolute(arcPath)) {
    api.events.emit("import-downloads", [arcPath], (dlIds: string[]) => {
      dlIds.forEach((dlId) => {
        api.events.emit("start-install-download", dlId);
      });
    });
  }
}

function init(context: IExtensionContext): boolean {
  const downloadCount = new ReduxProp(
    context.api,
    [["persistent", "downloads", "files"]],
    (downloads: { [dlId: string]: IDownload }) => {
      const count = Object.keys(downloads ?? {}).filter((id) =>
        ["init", "started", "paused"].includes(downloads[id].state),
      ).length;
      return count > 0 ? count : undefined;
    },
  );

  context.registerReducer(["persistent", "downloads"], stateReducer);
  context.registerReducer(["persistent", "transactions"], transactionsReducer);
  context.registerReducer(["settings", "downloads"], settingsReducer);

  const downloadPathForGame = (gameId: string) =>
    selectors.downloadPathForGame(context.api.getState(), gameId);

  const downloadColumns = (props: () => IDownloadViewProps) =>
    downloadAttributes(context.api, props, withAddInProgress);

  context.registerMainPage("download", "Downloads", DownloadView, {
    priority: 30,
    hotkey: "D",
    group: "global",
    badge: downloadCount,
    props: () => ({
      downloadPathForGame,
      columns: downloadColumns,
    }),
    mdi: mdiDownload,
  });

  context.registerSettings("Download", Settings, undefined, undefined, 75);

  context.registerFooter("speed-o-meter", SpeedOMeter);

  const queryCondition = (instanceIds: string[]) => {
    const state: IState = context.api.store.getState();
    const incomplete = instanceIds.find(
      (instanceId) =>
        getSafe<DownloadState>(state.persistent.downloads.files, [instanceId, "state"], "init") !==
        "finished",
    );
    return incomplete === undefined
      ? true
      : context.api.translate("Can only query finished downloads");
  };

  context.registerAction(
    "downloads-action-icons",
    100,
    "refresh",
    {},
    "Query Info",
    (instanceIds: string[]) => {
      queryInfo(context.api, instanceIds, true);
    },
    queryCondition,
  );
  context.registerAction(
    "downloads-multirow-actions",
    100,
    "refresh",
    {},
    "Query Info",
    (instanceIds: string[]) => {
      queryInfo(context.api, instanceIds, true);
    },
    queryCondition,
  );

  context.registerAttributeExtractor(100, attributeExtractor);
  context.registerAttributeExtractor(25, attributeExtractorCustom);
  context.registerActionCheck("SET_DOWNLOAD_FILEPATH", (state, action: any) => {
    if (action.payload === "") {
      return "Attempt to set invalid file name for a download";
    }
    return undefined;
  });

  context.registerActionCheck("INIT_DOWNLOAD", (state: IState, action: any) => {
    const { games } = action.payload;
    if (!truthy(games) || !Array.isArray(games) || games.length === 0) {
      return "No game associated with download";
    }
    return undefined;
  });

  context.registerActionCheck("ADD_LOCAL_DOWNLOAD", (state: IState, action: any) => {
    const { game } = action.payload;
    if (!truthy(game) || typeof game !== "string") {
      return "No game associated with download";
    }
    return undefined;
  });

  context.registerActionCheck("SET_COMPATIBLE_GAMES", (state, action: any) => {
    const { games } = action.payload;
    if (!truthy(games) || !Array.isArray(games) || games.length === 0) {
      return "Invalid set of compatible games";
    }
    return undefined;
  });

  const removeToastDebouncer = new Debouncer(
    () => {
      context.api.sendNotification({
        id: `download-removed`,
        type: "info",
        message: "Download(s) deleted",
        displayMS: 3000,
      });
      return PromiseBB.resolve();
    },
    500,
    true,
    false,
  );

  context.registerActionCheck("REMOVE_DOWNLOAD", (state: IState, action: any) => {
    // Uncomment to help debug unexpected download removal
    // const stack = new Error().stack;
    // if (stack !== undefined) {
    //   log('debug', 'download removed', { id: action.payload, stack });
    // }
    removeToastDebouncer.schedule();
    return undefined;
  });

  context.registerAction(
    "download-actions",
    100,
    ShutdownButton,
    {},
    () => ({
      t: context.api.translate,
      shutdownPending,
      activeDownloads: selectors.activeDownloads(context.api.getState()),
      toggleShutdown: () => toggleShutdown(context.api),
    }),
    () => true,
  );

  context.registerTest("verify-downloads-transfers", "gamemode-activated", () =>
    checkPendingTransfer(context.api),
  );

  context.once(() => {
    Object.assign(context.api.ext, extendAPI(context.api));

    const store = context.api.store;
    invalidateDownloadWatch();
    downloadMoves.clear();
    watchStore = store;

    testDownloadPath(context.api);

    // undo an earlier bug where vortex registered itself as the default http/https handler
    // (fortunately few applications actually rely on that setting, unfortunately this meant
    // the bug wasn't found for a long time)
    context.api.deregisterProtocol("http");
    context.api.deregisterProtocol("https");

    context.api.registerProtocol("http", false, (url, install) => {
      startDownloadFromURL(context.api, url, install);
    });

    context.api.registerProtocol("https", false, (url, install) => {
      startDownloadFromURL(context.api, url, install);
    });

    context.api.events.on("will-move-downloads", (move?: object) => {
      if (move !== undefined) downloadMoves.add(move);
      invalidateDownloadWatch();
    });
    context.api.events.on("downloads-move-finished", (move: object) => {
      downloadMoves.delete(move);
      if (downloadMoves.size === 0) updateDebouncer.schedule();
    });

    context.api.events.on("did-import-downloads", (dlIds: string[], cb?: (err?: Error) => void) => {
      queryInfo(context.api, dlIds, false)
        .then(() => cb?.())
        .catch((err) => cb?.(unknownToError(err)));
    });

    context.api.onStateChange(["settings", "downloads", "path"], () => {
      invalidateDownloadWatch();
      updateDebouncer.schedule();
    });
    context.api.onStateChange(["settings", "profiles", "activeProfileId"], () => {
      invalidateDownloadWatch();
      updateDebouncer.schedule();
    });

    context.api.onStateChange(
      ["persistent", "downloads", "files"],
      (prev: { [dlId: string]: IDownload }, cur: { [dlId: string]: IDownload }) => {
        // when files are added without mod info, query the meta database
        const added = _.difference(Object.keys(cur), Object.keys(prev));
        const filtered = added.filter(
          (dlId) => cur[dlId].state === "finished" && Object.keys(cur[dlId].modInfo).length === 0,
        );

        const state: IState = context.api.store.getState();

        const activeDls = selectors.activeDownloads(state);
        updateShutdown(activeDls);
        setErrorContext("active_downloads", String(Object.keys(activeDls).length));

        PromiseBB.map(filtered, (dlId) => {
          const rawGameId = getDownloadGames(cur[dlId])[0];
          const gameId = rawGameId
            ? convertGameIdReverse(knownGames(state), rawGameId) || rawGameId
            : rawGameId;
          const downloadPath = selectors.downloadPathForGame(state, gameId);
          if (cur[dlId].localPath === undefined) {
            // No point looking up metadata if we don't know the file's name.
            //  https://github.com/Nexus-Mods/Vortex/issues/7362
            log("warn", "failed to look up mod info", {
              id: dlId,
              reason: "Filename is unknown",
            });
            return PromiseBB.resolve();
          }
          context.api
            .lookupModMeta({
              filePath: path.join(downloadPath, cur[dlId].localPath),
              gameId: convertGameIdReverse(knownGames(context.api.getState()), cur[dlId].game[0]),
            })
            .then((result) => {
              if (result.length > 0) {
                const info = result[0].value;
                store.dispatch(setDownloadModInfo(dlId, "meta", info));
              }
            })
            .catch((err) => {
              log("warn", "failed to look up mod info", err);
            });
        })
          .catch(() => null)
          .then(() => null);
        return null;
      },
    );

    context.api.events.on("gamemode-activated", genGameModeActivated(context.api));

    context.api.events.on(
      "filehash-calculated",
      (filePath: string, md5Hash: string, fileSize: number) => {
        log("debug", "file hash calculated", {
          fileName: path.basename(filePath),
          md5Hash,
          fileSize,
        });
        const state = context.api.getState();
        const downloads = state.persistent.downloads.files;
        const matchingIds = Object.keys(downloads).filter((dlId) => {
          const download = downloads[dlId];
          const gameId = getDownloadGames(download)[0];
          return (
            gameId !== undefined &&
            download.localPath !== undefined &&
            path.relative(selectors.downloadPathForGame(state, gameId), filePath) ===
              download.localPath
          );
        });
        batchDispatch(
          context.api.store,
          matchingIds.map((dlId) => setDownloadHashAndSize(dlId, md5Hash, fileSize)),
        );
      },
    );

    context.api.events.on("enable-download-watch", (enabled: boolean) => {
      watchEnabled = enabled;
    });

    context.api.events.on("refresh-downloads", (gameId: string, callback: (err) => void) => {
      updateDownloadPath(context.api, gameId)
        .then(() => {
          if (callback !== undefined) {
            callback(null);
          }
        })
        .catch((err) => {
          if (callback !== undefined) {
            callback(err);
          }
        });
    });

    context.api.events.on("import-downloads", genImportDownloadsHandler(context.api));

    context.api.events.on(
      "browse-download-url",
      (navUrl: string, onComplete?: (err: Error | null, dlId?: string) => void) => {
        // browse-for-download surfaces its own browse-level failures and treats cancel as a no-op;
        // download failures reach onComplete. This catch is only unhandled-rejection hygiene.
        browseAndDownload(context.api, navUrl, onComplete).catch((err) => {
          log("error", "browse-download-url failed", { err });
        });
      },
    );

    context.api.onAsync<"set-download-games">(
      "set-download-games",
      (dlId: string, gameIds: string[], fromMetadata?: boolean) =>
        setDownloadGames(
          context.api,
          dlId,
          gameIds.filter((x) => !!x),
          withAddInProgress,
          fromMetadata === true,
        ),
    );

    // This debouncer is only needed to avoid a race condition caused primarily by the
    //  testDownloadPath functionality, where the update downloads function gets called twice
    //  in quick succession when the user browses and selects a new downloads folder. This causes,
    //  duplicate archives to get added.
    //   It gets called:
    //  1. Due to change in settings.downloads.path.
    //  2. Due to the gamemode-activated event.
    updateDebouncer = new Debouncer(() => {
      return updateDownloadPath(context.api);
    }, 1000);

    const state = context.api.getState();
    const downloads = state.persistent.downloads?.files ?? {};
    const gameMode = selectors.activeGameId(state);

    checkForUnfinalized(context.api, downloads, gameMode);
    removeDownloadsWithoutFile(store, downloads);

    processCommandline(context.api);
  });

  return true;
}

export default init;
