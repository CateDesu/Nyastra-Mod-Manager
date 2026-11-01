import { lstat, readlink, realpath, rm } from "node:fs/promises";
import * as path from "node:path";

import { getErrorCode } from "@vortex/shared";

import type { IExtensionApi } from "../../../types/IExtensionContext";
import type { IState } from "../../../types/IState";
import { resolveWinePath } from "../../../util/resolvePathCase";
import { knownGames } from "../../gamemode_management/selectors";
import { convertGameIdReverse } from "../../nexus_integration/util/convertGameId";
import { activeGameId } from "../../profile_management/selectors";
import { setDownloadModInfo } from "../actions/state";
import { downloadPathForGame } from "../selectors";
import type { IDownload } from "../types/IDownload";
import getDownloadGames from "./getDownloadGames";

const mutations = new WeakMap<IExtensionApi["store"], Promise<unknown>>();
const admissions = new WeakMap<IExtensionApi["store"], Set<object>>();

export function hasPendingArchiveAdmission(api: IExtensionApi): boolean {
  return (admissions.get(api.store)?.size ?? 0) > 0;
}

// Reserve the root without holding the mutation queue through protocol dialogs.
export async function withArchiveAdmission<T>(
  api: IExtensionApi,
  run: () => PromiseLike<T>,
): Promise<T> {
  const token = {};
  await withArchiveMutation(api, async () => {
    const pending = admissions.get(api.store) ?? new Set<object>();
    pending.add(token);
    admissions.set(api.store, pending);
  });
  try {
    return await run();
  } finally {
    const pending = admissions.get(api.store);
    pending?.delete(token);
    if (pending?.size === 0) admissions.delete(api.store);
  }
}

// Hold only filesystem and reducer work. Event listeners may start another mutation.
export function withArchiveMutation<T>(api: IExtensionApi, run: () => PromiseLike<T>): Promise<T> {
  const previous = mutations.get(api.store) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  mutations.set(api.store, current);
  return current.finally(() => {
    if (mutations.get(api.store) === current) mutations.delete(api.store);
  });
}

export function downloadArchivePath(state: IState, download: IDownload): string {
  const rawGame = getDownloadGames(download)[0] ?? activeGameId(state);
  const game = convertGameIdReverse(knownGames(state), rawGame) || rawGame;
  return path.resolve(downloadPathForGame(state, game), download.localPath);
}

export async function archiveOwners(api: IExtensionApi, downloadId: string, identity: string) {
  const state = api.getState();
  const owners = await Promise.all(
    Object.entries(state.persistent.downloads.files).map(async ([id, other]) => {
      if (id === downloadId || !other.localPath) return undefined;
      const archivePath = await resolveWinePath(downloadArchivePath(state, other));
      return (await physicalArchivePath(archivePath)) === identity
        ? { id, archivePath }
        : undefined;
    }),
  );
  return owners.filter((owner) => owner !== undefined);
}

export const MANAGED_ARCHIVE_KEY = "__nyastraManagedArchive";

export type ManagedArchive = { path: string; dev: number; ino: number; birthtimeMs: number };

export async function physicalArchivePath(filePath: string): Promise<string> {
  const resolved = await resolveWinePath(filePath);
  return realpath(resolved).catch((err) => {
    if (getErrorCode(err) === "ENOENT") return resolved;
    throw err;
  });
}

export async function archiveUsesEntry(filePath: string, entryPath: string): Promise<boolean> {
  for (let depth = 0; depth < 40; depth++) {
    const entry = path.join(
      await physicalArchivePath(path.dirname(filePath)),
      path.basename(filePath),
    );
    if (entry === entryPath) return true;
    try {
      filePath = path.resolve(path.dirname(entry), await readlink(entry));
    } catch (err) {
      if (["EINVAL", "ENOENT"].includes(getErrorCode(err))) return false;
      throw err;
    }
  }
  throw Object.assign(new Error("Too many archive symlinks"), { code: "ELOOP" });
}

export async function archiveOwnership(
  archivePath: string,
  identity: string,
  download: IDownload,
): Promise<{ managed?: ManagedArchive; fileAlias: boolean }> {
  const entry = await lstat(archivePath).catch((err) => {
    if (getErrorCode(err) === "ENOENT") return undefined;
    throw err;
  });
  if (entry?.isFile()) {
    return {
      managed: { path: identity, dev: entry.dev, ino: entry.ino, birthtimeMs: entry.birthtimeMs },
      fileAlias: false,
    };
  }
  const fileAlias = entry?.isSymbolicLink() ?? false;
  const previous = download.modInfo?.[MANAGED_ARCHIVE_KEY] as ManagedArchive | undefined;
  if (!fileAlias || previous?.path !== identity) return { fileAlias };
  const target = await lstat(identity);
  return {
    fileAlias,
    managed:
      target.isFile() &&
      target.dev === previous.dev &&
      target.ino === previous.ino &&
      target.birthtimeMs === previous.birthtimeMs
        ? previous
        : undefined,
  };
}

export async function removeArchiveFile(
  api: IExtensionApi,
  downloadId: string,
  download: IDownload,
): Promise<void> {
  if (!download.localPath) return;
  const archivePath = await resolveWinePath(downloadArchivePath(api.getState(), download));
  const identity = await physicalArchivePath(archivePath);
  const remaining = await archiveOwners(api, downloadId, identity);
  const { managed, fileAlias } = await archiveOwnership(archivePath, identity, download);
  if (remaining.length > 0) {
    if (managed !== undefined) {
      for (const { id } of remaining) {
        api.store.dispatch(setDownloadModInfo(id, MANAGED_ARCHIVE_KEY, managed));
      }
    }
    if (fileAlias) {
      const entry = path.join(
        await physicalArchivePath(path.dirname(archivePath)),
        path.basename(archivePath),
      );
      const sameEntry = await Promise.all(
        remaining.map((owner) => archiveUsesEntry(owner.archivePath, entry)),
      );
      if (!sameEntry.some(Boolean)) await rm(archivePath, { force: true });
    }
  } else {
    if (managed !== undefined && fileAlias) await rm(managed.path, { force: true });
    await rm(archivePath, { force: true });
  }
}
