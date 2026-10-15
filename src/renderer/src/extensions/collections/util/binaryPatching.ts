import { randomUUID } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import * as path from "path";

import { unknownToError } from "@vortex/shared";
import Bluebird from "bluebird";
import * as crc32 from "crc-32";
import SevenZip from "node-7z";

import type { IInstallResult } from "../../../extensions/mod_management/types/IInstallResult";
import type { IMod } from "../../../extensions/mod_management/types/IMod";
import renderModName from "../../../extensions/mod_management/util/modName";
import { convertGameIdReverse } from "../../../extensions/nexus_integration/util/convertGameId";
import { log } from "../../../logging";
import type { IDialogResult } from "../../../types/IDialog";
import type { IExtensionApi } from "../../../types/IExtensionContext";
import { DataInvalid, ProcessCanceled } from "../../../util/CustomErrors";
import * as fs from "../../../util/fs";
import * as selectors from "../../../util/selectors";
import { makeQueue } from "../../../util/util";
import { MAX_PATCH_SIZE, PATCHES_PATH, PATCH_OVERHEAD } from "../constants";
import { diffFiles, patchFiles } from "./bsdiff";

function crcFromBuf(data: Buffer) {
  // >>> 0 converts signed to unsigned
  return (crc32.buf(data) >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

export function patchPath(base: string, value: string): string {
  const portable = typeof value === "string" ? value.replace(/\\/g, "/") : "";
  const relative = path.posix.normalize(portable);
  if (
    !portable ||
    relative === "." ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(portable) ||
    /^[a-z]:/i.test(portable)
  )
    throw new DataInvalid(`Invalid collection patch path: ${value}`);
  return path.join(base, relative);
}

async function confinedPatchPath(base: string, filename: string): Promise<string> {
  const [root, resolved] = await Promise.all([realpath(base), realpath(filename)]);
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new DataInvalid(`Collection patch path is outside its directory: ${filename}`);
  }
  return resolved;
}

async function validatePatch(srcFilePath: string, patchFilePath: string) {
  const srcStats: fs.Stats = await fs.statAsync(srcFilePath);
  const patchStats: fs.Stats = await fs.statAsync(patchFilePath);
  if (patchStats.size - PATCH_OVERHEAD > srcStats.size * MAX_PATCH_SIZE) {
    throw new DataInvalid("patch too large");
  }
}

const queue = makeQueue();

export function scanForDiffs(
  api: IExtensionApi,
  gameId: string,
  modId: string,
  destPath: string,
  onProgress: (percent: number, text: string) => void,
): Bluebird<{ [filePath: string]: string }> {
  const state = api.getState();
  const mod = state.persistent.mods[gameId][modId];

  const stagingPath = selectors.installPathForGame(state, gameId);

  const localPath = path.join(stagingPath, mod.installationPath);
  const archive = state.persistent.downloads.files[mod.archiveId];

  if (archive === undefined) {
    throw new ProcessCanceled("Archive not found");
  }

  const choices = mod.attributes?.installerChoices;

  return queue(
    () =>
      new Bluebird((resolve, reject) => {
        api.events.emit(
          "simulate-installer",
          gameId,
          mod.archiveId,
          { choices },
          async (instRes: IInstallResult, tempPath: string) => {
            try {
              const rawGame = Array.isArray(archive.game) ? archive.game[0] : archive.game;
              const internalId = rawGame
                ? convertGameIdReverse(selectors.knownGames(state), rawGame) || rawGame
                : rawGame;
              const dlPath = selectors.downloadPathForGame(state, internalId);
              const archivePath = path.join(dlPath, archive.localPath);

              const sourceChecksums: { [fileName: string]: string } = {};
              const szip = new SevenZip();
              await szip.list(archivePath, undefined, async (entries) => {
                for (const entry of entries) {
                  if (entry.attr !== "D") {
                    try {
                      sourceChecksums[entry.name] = entry["crc"].toUpperCase();
                    } catch (err) {
                      api.showErrorNotification(
                        "Failed to determine checksum for file",
                        unknownToError(err),
                        {
                          message: entry.name,
                        },
                      );
                    }
                  }
                }
              });

              const result: { [filePath: string]: string } = {};

              for (const file of instRes.instructions.filter((instr) => instr.type === "copy")) {
                const srcCRC = sourceChecksums[file.source];
                const dstFilePath = path.join(localPath, file.destination);
                const dat = await fs.readFileAsync(dstFilePath);
                const dstCRC = crcFromBuf(dat);
                if (srcCRC !== dstCRC) {
                  onProgress(
                    undefined,
                    api.translate("Creating patch for {{fileName}}", {
                      replace: {
                        fileName: path.basename(file.source),
                      },
                    }),
                  );
                  log("debug", "found modified file", {
                    filePath: file.source,
                    srcCRC,
                    dstCRC,
                  });
                  const srcFilePath = path.join(tempPath, file.source);
                  const patchPath = path.join(destPath, file.destination + ".diff");
                  await fs.ensureDirWritableAsync(path.dirname(patchPath));
                  await diffFiles(srcFilePath, dstFilePath, patchPath);
                  try {
                    await validatePatch(srcFilePath, patchPath);
                    result[file.destination] = srcCRC;
                  } catch (err) {
                    await fs.removeAsync(patchPath);

                    const res: IDialogResult = await api.showDialog(
                      "error",
                      "Can't save local edits",
                      {
                        text:
                          'The local modifications to file "{{fileName}}" can not be included in ' +
                          "the collection.\n" +
                          "We don't allow edits that exceed a certain percentage " +
                          "of the original file size.\n" +
                          "If you continue anyway this file will be installed unmodified for users.",
                        parameters: {
                          fileName: file.source,
                        },
                      },
                      [{ label: "Cancel" }, { label: "Continue" }],
                    );

                    if (res.action === "Cancel") {
                      err["mayIgnore"] = false;
                      throw err;
                    }
                  }
                  log("debug", "patch created at", patchPath);
                }
              }
              resolve(result);
            } catch (err) {
              reject(err);
            }
          },
        );
      }),
    false,
  ) as Bluebird<{ [filePath: string]: string }>;
}

export async function applyPatches(
  api: IExtensionApi,
  collection: IMod,
  gameId: string,
  modName: string,
  modId: string,
  patches: { [filePath: string]: string },
) {
  const state = api.getState();
  const installPath = selectors.installPathForGame(state, gameId);
  const mod = state.persistent.mods[gameId][modId];
  for (const filePath of Object.keys(patches ?? {})) {
    try {
      const modPath = patchPath(installPath, mod.installationPath);
      const patchesRoot = path.join(
        patchPath(installPath, collection.installationPath),
        PATCHES_PATH,
      );
      const patchesPath = patchPath(patchesRoot, modName);
      const source = patchPath(modPath, filePath);
      const diff = patchPath(patchesPath, filePath) + ".diff";
      const realModPath = await confinedPatchPath(installPath, modPath);
      const realPatchesPath = await confinedPatchPath(patchesRoot, patchesPath);
      await confinedPatchPath(installPath, realPatchesPath);
      const srcPath = await confinedPatchPath(realModPath, source);
      const diffPath = await confinedPatchPath(realPatchesPath, diff);
      // if the patch is missing, trigger the error here because bsdiff would produce a non-standard
      // string exception
      await fs.statAsync(diffPath);
      const srcDat = await fs.readFileAsync(srcPath);
      const srcCRC = crcFromBuf(srcDat);
      if (srcCRC === patches[filePath]) {
        const output = `${srcPath}.${randomUUID()}.patched`;
        try {
          await patchFiles(srcPath, output, diffPath);
          await fs.renameAsync(output, srcPath);
        } finally {
          await rm(output, { force: true });
        }
        log("info", "patched", srcPath);
      } else {
        log("warn", "patch not applied because reference CRC differs", {
          filePath,
          srcCRC,
        });
      }
    } catch (err) {
      err["Collection"] = renderModName(collection);
      api.showErrorNotification("failed to patch", unknownToError(err), {
        message: filePath,
      });
    }
  }
}
