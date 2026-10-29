import * as path from "path";

import { getErrorCode } from "@vortex/shared";
import PromiseBB from "bluebird";

import { UserCanceled } from "../../util/CustomErrors";
import * as fs from "../../util/fs";
import { copyFileAtomic } from "../../util/fsAtomic";
import { log } from "../../util/log";

function copyProfileFiles(
  sourceFiles: string[],
  copy: (filename: string) => PromiseBB<void>,
): PromiseBB<void> {
  return PromiseBB.map(sourceFiles, (filename) =>
    PromiseBB.try(() => copy(filename)).reflect(),
  ).then((results) => {
    const failure = results.find((result) => result.isRejected());
    if (failure !== undefined) throw failure.reason();
  });
}

export function syncToProfile(
  profilePath: string,
  sourceFiles: string[],
  onError: (error: string, details: string | Error, allowReport?: boolean) => void,
): PromiseBB<void> {
  log("debug", "sync to profile", { profilePath, sourceFiles });
  return fs
    .ensureDirAsync(profilePath)
    .then(() =>
      copyProfileFiles(sourceFiles, (filePath: string) => {
        const destPath = path.join(profilePath, path.basename(filePath));
        return copyFileAtomic(filePath, destPath).catch((err) => {
          if (getErrorCode(err) === "ENOENT") return;
          log("warn", "failed to copy to profile", { filePath, destPath });
          if (!(err instanceof UserCanceled)) {
            onError("failed to sync to profile: " + filePath, err);
          }
          throw err;
        });
      }),
    )
    .then(() => {
      log("debug", "sync to profile complete");
    });
}

export function syncFromProfile(
  profilePath: string,
  sourceFiles: string[],
  onError: (error: string, details: string | Error, allowReport?: boolean) => void,
): PromiseBB<void> {
  log("debug", "sync from profile", { profilePath, sourceFiles });
  return copyProfileFiles(sourceFiles, (filePath: string) => {
    const srcPath = path.join(profilePath, path.basename(filePath));
    return copyFileAtomic(srcPath, filePath).catch((err) => {
      if (getErrorCode(err) === "ENOENT") return;
      if (getErrorCode(err) === "EPERM") {
        onError("failed to sync from profile", `${filePath} is write protected`, false);
      } else if (!(err instanceof UserCanceled)) {
        onError("failed to sync from profile", err);
      }
      throw err;
    });
  }).then(() => {
    log("debug", "sync from profile complete");
  });
}
