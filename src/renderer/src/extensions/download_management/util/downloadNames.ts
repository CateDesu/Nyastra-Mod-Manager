import { constants } from "node:fs";
import { copyFile, link, rm } from "node:fs/promises";
import * as path from "path";

import type { IDownload } from "../types/IDownload";

// Placeholder filename a download uses on disk while in progress, renamed to the
// real name on completion. The UI shows friendlyDownloadName in its place.
export const TEMP_DOWNLOAD_PREFIX = "__vortex_tmp_";

/** Download names can contain path hints from either server platform. */
export function normalizeDownloadFileName(fileName: string): string {
  const name = fileName.split(/[\\/]/).at(-1) ?? "";
  if (name === "" || name === "." || name === ".." || name.includes("\0")) {
    throw new Error("Invalid download filename");
  }
  return name;
}

export function isTempDownloadName(name: string | undefined): boolean {
  return name !== undefined && name.startsWith(TEMP_DOWNLOAD_PREFIX);
}

/** File name from a URL's basename, best-effort; undefined if missing/unparseable. */
export function nameFromUrl(input: string | undefined): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  try {
    const pathname = new URL(input).pathname;
    return decodeURI(path.basename(pathname));
  } catch {
    return undefined;
  }
}

/**
 * Name to show for a download. Prefers the real on-disk name; while the temp
 * placeholder is still in use, falls back to metadata or the URL so the user
 * doesn't see __vortex_tmp_*.
 */
export function friendlyDownloadName(download: IDownload): string | undefined {
  const localPath = download.localPath;
  if (localPath && !isTempDownloadName(localPath)) {
    return localPath;
  }

  const candidates: Array<string | undefined> = [
    download.modInfo?.name,
    download.modInfo?.meta?.logicalFileName,
    download.modInfo?.meta?.fileName,
    download.modInfo?.nexus?.fileInfo?.name,
    nameFromUrl(download.urls?.[0]),
  ];
  const friendly = candidates.find(Boolean);

  // Fall back to the temp name so sort/filter stay stable before metadata resolves.
  return friendly ?? localPath;
}

/**
 * Move a finished download under an available name without replacing another archive.
 */
export async function moveDownloadToFreeName(
  source: string,
  dlPath: string,
  fileName: string,
): Promise<string> {
  fileName = normalizeDownloadFileName(fileName);
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  const stamp = Date.now();
  let candidate = fileName;
  let collisions = 0;
  for (;;) {
    try {
      const destination = path.join(dlPath, candidate);
      try {
        await link(source, destination);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!["EXDEV", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(code)) throw err;
        await copyFile(source, destination, constants.COPYFILE_EXCL);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      collisions += 1;
      candidate = `${base}.${stamp}${collisions === 1 ? "" : `.${collisions}`}${ext}`;
      continue;
    }
    // The destination is complete. Leftover temporary files can be cleaned up later.
    await rm(source, { force: true }).catch(() => undefined);
    return candidate;
  }
}
