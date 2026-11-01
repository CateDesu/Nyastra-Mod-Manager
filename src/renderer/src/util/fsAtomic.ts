import { createHash } from "crypto";
import { constants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdtemp,
  readlink,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
  utimes,
} from "node:fs/promises";
import * as path from "node:path";

import { unknownToError } from "@vortex/shared";
import PromiseBB from "bluebird";
import { file } from "tmp";

import { checksum } from "./checksum";
import * as fs from "./fs";
import { log } from "./log";

/** Move a file or symlink without replacing an occupied destination. */
export async function moveFileNoReplace(source: string, destination: string): Promise<void> {
  const sourceParent = await realpath(path.dirname(source));
  const holding = await mkdtemp(path.join(sourceParent, ".nyastra-file-move-"));
  const claimed = path.join(holding, "source");
  let owned = false;
  let linkTarget: string | undefined;
  try {
    // Only the private entry may be retired after publication.
    await rename(source, claimed);
    owned = true;
    const stats = await lstat(claimed);
    if (stats.isSymbolicLink()) {
      linkTarget = await readlink(claimed);
      const destinationParent = await realpath(path.dirname(destination));
      const prefix = path.relative(destinationParent, sourceParent);
      // Keep parent segments after directory links for native traversal.
      const target =
        path.isAbsolute(linkTarget) || prefix === ""
          ? linkTarget
          : `${prefix}${path.sep}${linkTarget}`;
      await symlink(target, destination);
    } else {
      if (!stats.isFile()) {
        throw Object.assign(new Error("Cannot move a non-regular file"), { code: "EINVAL" });
      }
      try {
        // Existing writers continue writing the published inode.
        await link(claimed, destination);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!["EXDEV", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(code)) throw err;
        await copyFile(claimed, destination, constants.COPYFILE_EXCL);
        await utimes(destination, stats.atime, stats.mtime);
        throw Object.assign(
          new Error("File copied, but the source is retained because writers may still be active"),
          { code: "EBUSY" },
        );
      }
    }
    await unlink(claimed);
    owned = false;
  } catch (err) {
    if (owned) {
      let recoveryPath = claimed;
      try {
        if (linkTarget !== undefined) await symlink(linkTarget, source);
        else await link(claimed, source);
        recoveryPath = source;
        await unlink(claimed);
        owned = false;
      } catch {
        // A recreated source keeps its name. The claimed bytes remain recoverable.
      }
      const failure = unknownToError(err) as NodeJS.ErrnoException;
      failure.message += `. Source preserved at ${recoveryPath}`;
      // Callers interpret ENOENT as a source that disappeared before the move.
      if (failure.code === "ENOENT") failure.code = "EIO";
      throw Object.assign(failure, { recoveryPath });
    }
    throw err;
  } finally {
    await rmdir(holding).catch(() => undefined);
  }
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
        tmpdir: path.dirname(path.resolve(filePath)),
        template: `${path.basename(filePath)}.XXXXXX.tmp`,
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
  const options = {
    tmpdir: path.dirname(path.resolve(destPath)),
    template: `${path.basename(destPath)}.XXXXXX.tmp`,
    discardDescriptor: true,
  };
  return new PromiseBB<void>((resolve, reject) => {
    // Close tmp's descriptor before copyFile opens the temporary path.
    file(options, (err: any, genPath: string, _fd: number, cleanupCB: () => void) => {
      if (err) {
        return reject(err);
      }
      cleanup = cleanupCB;
      tmpPath = genPath;
      resolve();
    });
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
