//
// Functions for changing game id on a download.
// Since we arrange downloads into directories based on the "primary" game,
// changing the game id may cause a file to be moved, which needs to happen before the
// state gets updated.
//

import { constants } from "node:fs";
import { copyFile, stat } from "node:fs/promises";
import path from "path";

import { getErrorCode } from "@vortex/shared";

import { setDownloadCheckpoint } from "../../../actions/downloads";
import type { IExtensionApi } from "../../../types/IExtensionContext";
import type { IState } from "../../../types/IState";
import { ProcessCanceled, UserCanceled } from "../../../util/CustomErrors";
import * as fs from "../../../util/fs";
import getNormalizeFunc from "../../../util/getNormalizeFunc";
import { log } from "../../../util/log";
import { resolveWinePath } from "../../../util/resolvePathCase";
import { batchDispatch, truthy } from "../../../util/util";
import { setCompatibleGames, setDownloadFilePath, setDownloadModInfo } from "../actions/state";
import { downloadPathForGame } from "../selectors";
import type { IDownload } from "../types/IDownload";
import {
  archiveOwners,
  archiveOwnership,
  downloadArchivePath,
  MANAGED_ARCHIVE_KEY,
  physicalArchivePath,
  removeArchiveFile,
  withArchiveMutation,
  type ManagedArchive,
} from "./archiveOwnership";

type TrackedArchive = ManagedArchive & { download: IDownload };
const relocations = new WeakMap<IExtensionApi["store"], Map<string, TrackedArchive[]>>();

export function trackDownloadRelocations(api: IExtensionApi, id: string, initial: TrackedArchive) {
  let tracked = relocations.get(api.store);
  if (tracked === undefined) {
    tracked = new Map();
    relocations.set(api.store, tracked);
  }
  const archives = [initial];
  tracked.set(id, archives);
  return {
    archives,
    stop: () => {
      tracked.delete(id);
      if (tracked.size === 0) relocations.delete(api.store);
    },
  };
}

async function setDownloadGames(
  api: IExtensionApi,
  dlId: string,
  gameIds: string[],
  withAddInProgress: (fileName: string, cb: () => PromiseLike<void>) => PromiseLike<void>,
  bypassProgressTracking: boolean = false,
) {
  gameIds = gameIds.filter((x) => truthy(x));
  if (gameIds.length === 0) return;
  const moveOperation = () =>
    withArchiveMutation(api, async () => {
      const state = api.getState();
      const download = state.persistent.downloads.files[dlId];
      if (download?.localPath === undefined) return;
      const fromGameId = Array.isArray(download.game) ? download.game[0] : download.game;
      if (fromGameId === gameIds[0]) {
        api.store.dispatch(setCompatibleGames(dlId, gameIds));
        return;
      }
      if (["init", "started", "finalizing"].includes(download.state)) {
        throw new ProcessCanceled("Pause the download before changing its game");
      }
      const source = await resolveWinePath(downloadArchivePath(state, download));
      const identity = await physicalArchivePath(source);
      const tracked = relocations.get(api.store)?.get(dlId);
      const sourceStat = tracked === undefined ? undefined : await stat(source);
      const owned =
        sourceStat !== undefined &&
        tracked?.some(
          (archive) =>
            archive.path === identity &&
            archive.dev === sourceStat.dev &&
            archive.ino === sourceStat.ino &&
            archive.birthtimeMs === sourceStat.birthtimeMs,
        );
      const owners = await archiveOwners(api, dlId, identity);
      const { fileAlias, managed } = await archiveOwnership(source, identity, download);
      const filePath = await moveDownload(
        state,
        source,
        gameIds[0],
        owners.length > 0 || fileAlias,
      );
      if (owners.length > 0) {
        if (managed !== undefined) {
          for (const { id } of owners)
            api.store.dispatch(setDownloadModInfo(id, MANAGED_ARCHIVE_KEY, managed));
        }
      }
      const destinationIdentity = await physicalArchivePath(filePath);
      if (managed !== undefined && destinationIdentity === identity) {
        api.store.dispatch(setDownloadModInfo(dlId, MANAGED_ARCHIVE_KEY, managed));
      }
      const batched: Parameters<typeof batchDispatch>[1] = [setCompatibleGames(dlId, gameIds)];
      const fileName = path.basename(filePath);
      if (fileName !== download.localPath) batched.push(setDownloadFilePath(dlId, fileName));
      const checkpoint = api.getState().persistent.downloads.checkpoints?.[dlId];
      if (checkpoint !== undefined) {
        batched.push(setDownloadCheckpoint(dlId, { ...checkpoint, dest: filePath }));
      }
      batchDispatch(api.store, batched);
      if (owned && tracked !== undefined && destinationIdentity !== identity) {
        const moved = await stat(filePath);
        tracked.push({
          path: destinationIdentity,
          dev: moved.dev,
          ino: moved.ino,
          birthtimeMs: moved.birthtimeMs,
          download: api.getState().persistent.downloads.files[dlId],
        });
      }
      if (fileAlias && destinationIdentity !== identity) {
        await removeArchiveFile(api, dlId, download);
      }
    });
  try {
    if (bypassProgressTracking) await moveOperation();
    else {
      const fileName = api.getState().persistent.downloads.files[dlId]?.localPath;
      if (fileName !== undefined) await withAddInProgress(fileName, moveOperation);
    }
  } catch (err) {
    if (err instanceof UserCanceled) log("warn", "updating games for download canceled");
    else if (err instanceof ProcessCanceled) {
      log("warn", "updating games for download failed", {
        error: err.message,
        from: err["oldPath"],
        to: err["newPath"],
      });
    } else api.showErrorNotification("Failed to move download", err);
  }
}

async function moveDownload(
  state: IState,
  source: string,
  toGameId: string,
  retainSource: boolean,
): Promise<string> {
  const oldPath = path.dirname(source);
  const fileName = path.basename(source);
  const newPath = downloadPathForGame(state, toGameId);
  if (newPath === undefined) {
    return Promise.reject(new ProcessCanceled(`No download path for game ${toGameId}`));
  }

  const normalize = await getNormalizeFunc(oldPath);
  const dest = await resolveWinePath(path.join(newPath, fileName));
  if (
    normalize(source) === normalize(dest) ||
    (await physicalArchivePath(source)) === (await physicalArchivePath(dest))
  ) {
    return dest;
  }
  await fs.ensureDirWritableAsync(newPath);
  if (retainSource) {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    let candidate = dest;
    for (let counter = 1; ; counter++) {
      try {
        await copyFile(source, candidate, constants.COPYFILE_EXCL);
        return candidate;
      } catch (err) {
        if (getErrorCode(err) !== "EEXIST") throw err;
        candidate = path.join(path.dirname(dest), `${base}.${counter}${ext}`);
      }
    }
  }
  return fs
    .moveRenameAsync(source, dest)
    .catch((err) => (err.code === "ENOENT" ? Promise.resolve(dest) : Promise.reject(err)));
}

export default setDownloadGames;
