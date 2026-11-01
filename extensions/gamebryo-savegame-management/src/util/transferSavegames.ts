import * as nodeFs from "node:fs";
import * as path from "path";

import PromiseBB from "bluebird";

import { saveFiles } from "./gameSupport";

const pendingTransfers = new Map<string, PromiseBB<void>>();

async function exists(file: string): Promise<boolean> {
  try {
    await nodeFs.promises.lstat(file);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/**
 * copy or move a list of savegame files
 *
 * @param {string} sourceSavePath
 * @param {string} destSavePath
 * @param {boolean} justCopy
 */
function transferSavegames(
  gameId: string,
  savegames: string[],
  sourceSavePath: string,
  destSavePath: string,
  keepSource: boolean,
): PromiseBB<string[]> {
  const destination = path.resolve(destSavePath);
  const previous = pendingTransfers.get(destination) ?? PromiseBB.resolve();
  const transfer = previous.then(async () => {
    const failedCopies: string[] = [];
    const files = Array.from(new Set(savegames.flatMap((name) => saveFiles(gameId, name))));
    const available: string[] = [];
    const claimed: string[] = [];

    // Check the complete batch before moving any source files.
    for (const save of files) {
      try {
        if (!(await exists(path.join(sourceSavePath, save)))) {
          continue;
        }
        if (await exists(path.join(destination, save))) {
          throw new Error("Destination already exists");
        }
        available.push(save);
      } catch (err) {
        failedCopies.push(save + " - " + err.message);
      }
    }
    if (failedCopies.length > 0) {
      return failedCopies;
    }

    let holding: string | undefined;
    try {
      if (!keepSource && available.length > 0) {
        holding = await nodeFs.promises.mkdtemp(path.join(sourceSavePath, ".nyastra-save-move-"));
        for (const save of available) {
          try {
            await nodeFs.promises.rename(path.join(sourceSavePath, save), path.join(holding, save));
            claimed.push(save);
          } catch (err) {
            if (err.code !== "ENOENT") failedCopies.push(save + " - " + err.message);
          }
        }
      }

      if (failedCopies.length === 0) {
        for (const save of keepSource ? available : claimed) {
          const source = path.join(holding ?? sourceSavePath, save);
          try {
            if (keepSource) {
              await nodeFs.promises.copyFile(
                source,
                path.join(destination, save),
                nodeFs.constants.COPYFILE_EXCL,
              );
            } else {
              if (!(await nodeFs.promises.lstat(source)).isFile()) {
                throw new Error("Cannot move a non-regular save file");
              }
              try {
                // Keep open writers attached to the destination inode.
                await nodeFs.promises.link(source, path.join(destination, save));
              } catch (err) {
                if (!["EXDEV", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(err.code)) throw err;
                await nodeFs.promises.copyFile(
                  source,
                  path.join(destination, save),
                  nodeFs.constants.COPYFILE_EXCL,
                );
                failedCopies.push(
                  save + " - Copied, but source retained because writers may still be active",
                );
              }
            }
          } catch (err) {
            if (err.code !== "ENOENT" || (await exists(source))) {
              failedCopies.push(save + " - " + err.message);
            }
          }
        }
      }
    } catch (err) {
      failedCopies.push(sourceSavePath + " - " + err.message);
    } finally {
      for (const save of claimed) {
        const source = path.join(holding, save);
        try {
          if (failedCopies.length > 0) {
            // Restore without replacing a save recreated by the game.
            await nodeFs.promises.link(source, path.join(sourceSavePath, save));
          }
          await nodeFs.promises.unlink(source);
        } catch (err) {
          failedCopies.push(save + " - Source preserved at " + source + ": " + err.message);
        }
      }
      if (holding !== undefined) {
        await nodeFs.promises.rmdir(holding).catch(() => undefined);
      }
    }
    return failedCopies;
  });
  const settled = transfer.then(
    () => undefined,
    () => undefined,
  );
  pendingTransfers.set(destination, settled);
  return transfer.finally(() => {
    if (pendingTransfers.get(destination) === settled) {
      pendingTransfers.delete(destination);
    }
  });
}

export default transferSavegames;
