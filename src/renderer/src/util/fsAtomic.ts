import { createHash } from "crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, readlink, rename, symlink, unlink, utimes } from "node:fs/promises";

import { unknownToError } from "@vortex/shared";
import PromiseBB from "bluebird";
import { file } from "tmp";

import { checksum } from "./checksum";
import * as fs from "./fs";
import { log } from "./log";

/** Move a file or symlink without replacing an occupied destination. */
export async function moveFileNoReplace(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!["EXDEV", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(code)) throw err;
    const stats = await lstat(source);
    if (stats.isSymbolicLink()) {
      await symlink(await readlink(source), destination);
    } else {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      await utimes(destination, stats.atime, stats.mtime);
    }
  }
  await unlink(source);
}

export function writeFileAtomic(filePath: string, input: string | Buffer) {
  return writeFileAtomicImpl(filePath, input, 3);
}

function writeFileAtomicImpl(
  filePath: string,
  input: string | Buffer,
  attempts: number,
): PromiseBB<void> {
  const stackErr = new Error();
  let cleanup: (() => void) | undefined;
  let tmpPath: string;
  const buf: Buffer = input instanceof Buffer ? input : Buffer.from(input);

  const callCleanup = () => {
    if (cleanup !== undefined) {
      try {
        cleanup();
      } catch (err) {
        log("error", "failed to clean up temporary file", err);
      }

      cleanup = undefined;
    }
  };

  const hash = checksum(buf);
  let fd = -1;
  return fs
    .withTmpFile(
      (fdIn: number, pathIn: string) => {
        fd = fdIn;
        tmpPath = pathIn;
        cleanup = () => fs.removeSync(pathIn);
        return fs
          .writeAsync(fd, buf, 0, buf.byteLength, 0)
          .then(() => fs.fsyncAsync(fd).catch(() => PromiseBB.resolve()))
          .catch((err) => {
            callCleanup();
            throw err;
          })
          .finally(() => fs.closeAsync(fd).catch(() => PromiseBB.resolve()));
      },
      {
        cleanup: false,
        detachDescriptor: true,
        template: `${filePath}.XXXXXX.tmp`,
      },
    )
    .then(() => fs.readFileAsync(tmpPath))
    .catch({ code: "EBADF" }, () => {
      log("warn", "failed to access temporary file", {
        filePath,
        fd,
      });
      return PromiseBB.resolve(undefined);
    })
    .then((data) => {
      if (data === undefined || checksum(data) !== hash) {
        callCleanup();
        return attempts > 0
          ? writeFileAtomicImpl(filePath, input, attempts - 1)
          : PromiseBB.reject(new Error("Write failed, checksums differ"));
      } else {
        return fs.renameAsync(tmpPath, filePath);
      }
    })
    .catch((unknownErr) => {
      const err = unknownToError(unknownErr);
      err.stack = err.stack + "\n" + stackErr.stack;
      return PromiseBB.reject(err);
    })
    .finally(() => {
      callCleanup();
    });
}

/** Copy to a sibling temporary file so failures leave the destination intact. */
export function copyFileAtomic(srcPath: string, destPath: string): PromiseBB<void> {
  let cleanup: (next?: (err?: Error) => void) => void;
  let tmpPath: string;
  return new PromiseBB<void>((resolve, reject) => {
    // Close tmp's descriptor before copyFile opens the temporary path.
    file(
      { template: `${destPath}.XXXXXX.tmp`, discardDescriptor: true },
      (err: any, genPath: string, _fd: number, cleanupCB: () => void) => {
        if (err) {
          return reject(err);
        }
        cleanup = cleanupCB;
        tmpPath = genPath;
        resolve();
      },
    );
  })
    .then(() => copyFile(srcPath, tmpPath))
    .then(() => (tmpPath !== undefined ? rename(tmpPath, destPath) : PromiseBB.resolve()))
    .catch((unknownErr) => {
      const err = unknownToError(unknownErr);
      log("info", "failed to copy", { srcPath, destPath, err: err.stack });
      // Remove the temporary file before rejecting.
      const removeTmp =
        cleanup !== undefined
          ? new PromiseBB<void>((removed) => cleanup(() => removed()))
          : PromiseBB.resolve();
      return removeTmp.then(() => PromiseBB.reject(err));
    });
}
