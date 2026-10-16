import { lstat } from "node:fs/promises";
import * as path from "path";
import * as util from "util";

import { getErrorCode, getErrorMessageOrDefault, unknownToError } from "@vortex/shared";
import PromiseBB from "bluebird";
import type { TFunction } from "i18next";
import type { IEntry } from "turbowalk";
import turbowalk from "turbowalk";

import { setSettingsPage } from "../../actions/session";
import { log } from "../../logging";
import type { IExtensionApi, IExtensionContext } from "../../types/IExtensionContext";
import type { IGame } from "../../types/IGame";
import type { IState } from "../../types/IState";
import * as fs from "../../util/fs";
import { installPathForGame } from "../../util/selectors";
import type { IDiscoveryResult } from "../gamemode_management/types/IDiscoveryResult";
import { getGame } from "../gamemode_management/util/getGame";
import LinkingDeployment from "../mod_management/LinkingDeployment";
import type {
  IDeployedFile,
  IDeploymentMethod,
  IUnavailableReason,
} from "../mod_management/types/IDeploymentMethod";

export class FileFound extends Error {
  constructor(name: string) {
    super(name);
    this.name = this.constructor.name;
  }
}

class DeploymentMethod extends LinkingDeployment {
  public priority: number = 5;

  private mInstallationFiles: Set<string>;

  constructor(api: IExtensionApi) {
    super(
      "hardlink_activator",
      "Hardlink Deployment",
      "Deploys mods by setting hard links in the destination directory.",
      true,
      api,
    );
  }

  public detailedDescription(t: TFunction): string {
    return t(
      "File Systems store files in two parts: \n" +
        " - an index entry that contains the file name, " +
        "access rights, change and creating times and so on\n" +
        " - the actual file data\n" +
        "Hard Links work by creating a second index entry referencing " +
        "the same data as the original. The second index is " +
        'a full-fledged index, so there is no differentiation between "original" and "link" ' +
        "after the link was created.\n" +
        "Advantages:\n" +
        " - perfect compatibility with all applications\n" +
        " - no performance penalty\n" +
        " - Wide OS and FS support\n" +
        "Disadvantages:\n" +
        " - mods have to be on the same partition as the game\n" +
        ' - Due to fact hard links are so "compatible", a lot of applications will act ' +
        "as if original and link were separate files. This includes some backup solutions, tools " +
        "that measure used disk space and so on, so it will often look like the link was actually " +
        "a copy.",
    );
  }

  public isSupported(state: IState, gameId: string, typeId: string): IUnavailableReason {
    const discovery: IDiscoveryResult = state.settings.gameMode.discovered[gameId];
    if (discovery?.path == null) {
      return {
        description: (t) => t("Game not discovered."),
      };
    }

    const game: IGame = getGame(gameId);
    const modPaths = game.getModPaths(discovery.path);

    if (modPaths[typeId] === undefined) {
      return undefined;
    }

    try {
      fs.accessSync(modPaths[typeId], fs.constants.W_OK);
    } catch {
      log("info", "hardlink deployment not supported due to lack of write access", {
        typeId,
        path: modPaths[typeId],
      });
      return {
        description: (t) => t("Can't write to output directory."),
        order: 3,
        solution: (t) =>
          t(
            "To resolve this problem, the current user account needs to be given " +
              'write permission to "{{modPath}}".',
            {
              replace: {
                modPath: modPaths[typeId],
              },
            },
          ),
      };
    }

    const installationPath = installPathForGame(state, gameId);

    try {
      if (fs.statSync(installationPath).dev !== fs.statSync(modPaths[typeId]).dev) {
        // hard links work only on the same drive
        return {
          description: (t) => t("Works only if mods are installed on the same drive as the game."),
          order: 5,
          solution: (t) => {
            const displayPath = modPaths[typeId];
            return t(
              "Please go to Settings->Mods and set the mod staging folder to be on " +
                "the same drive as the game ({{gameVolume}}).",
              {
                replace: {
                  gameVolume: displayPath,
                },
              },
            );
          },
          fixCallback: (api: IExtensionApi) =>
            new PromiseBB((_resolve, _reject) => {
              api.events.emit("show-main-page", "application_settings");
              api.store.dispatch(setSettingsPage("Mods"));
              api.highlightControl(
                "#install-path-form",
                5000,
                "Change this to be on the same drive as the game.",
              );
            }),
        };
      }
    } catch (err) {
      // this can happen when managing the the game for the first time
      log("info", "failed to stat. directory missing?", {
        dir1: installationPath || "undefined",
        dir2: modPaths[typeId],
        err: util.inspect(err),
      });
      return {
        description: (t) => t("Game not fully initialized yet, this should disappear soon."),
      };
    }

    const canary = path.join(installationPath, "__vortex_canary.tmp");

    let res: IUnavailableReason;

    try {
      try {
        fs.removeSync(canary + ".link");
      } catch {
        // nop
      }
      fs.writeFileSync(canary, "Should only exist temporarily, feel free to delete");
      fs.linkSync(canary, canary + ".link");
    } catch (err) {
      // EMFILE shouldn't keep us from using hard linking
      const code = getErrorCode(err);
      if (code !== "EMFILE") {
        // the error code we're actually getting is EISDIR, which makes no sense at all
        res = {
          description: (t) => t("Filesystem doesn't support hard links."),
        };
      }
    }

    try {
      fs.removeSync(canary + ".link");
      fs.removeSync(canary);
    } catch {
      // cleanup failed, this is almost certainly due to an AV jumping in to check these new files,
      // I mean, why would I be able to create the files but not delete them?
      // just try again later - can't do that synchronously though
      PromiseBB.delay(100)
        .then(() => fs.removeAsync(canary + ".link"))
        .then(() => fs.removeAsync(canary))
        .catch((err) => {
          log(
            "error",
            "failed to clean up canary file. This indicates we were able to create " +
              "a file in the target directory but not delete it",
            { installationPath, message: getErrorMessageOrDefault(err) },
          );
        });
    }

    return res;
  }

  public finalize(
    gameId: string,
    dataPath: string,
    installationPath: string,
    progressCB?: (files: number, total: number) => void,
  ): PromiseLike<IDeployedFile[]> {
    return super.finalize(gameId, dataPath, installationPath, progressCB);
  }

  public postPurge(): PromiseBB<void> {
    delete this.mInstallationFiles;
    this.mInstallationFiles = undefined;
    return PromiseBB.resolve();
  }

  private async getFileId(entry: IEntry): Promise<string | undefined> {
    if (entry.isDirectory) {
      return undefined;
    }

    // The POSIX walker omits file IDs and link counts even with details enabled.
    try {
      const stats = await lstat(entry.filePath, { bigint: true });
      return !stats.isDirectory() && stats.nlink > 1n ? `${stats.dev}:${stats.ino}` : undefined;
    } catch (err) {
      if (getErrorCode(err) === "ENOENT") {
        return undefined;
      }
      throw unknownToError(err);
    }
  }

  protected purgeLinks(
    installationPath: string,
    dataPath: string,
    onProgress?: (num: number, total: number) => void,
  ): PromiseBB<void> {
    let installEntryProm: PromiseBB<Set<string>>;

    // String identities preserve file IDs larger than Number.MAX_SAFE_INTEGER.
    if (this.mInstallationFiles !== undefined) {
      installEntryProm = PromiseBB.resolve(this.mInstallationFiles);
    } else {
      this.mInstallationFiles = new Set<string>();
      let queue = PromiseBB.resolve();
      installEntryProm = turbowalk(
        installationPath,
        (entries) => {
          if (this.mInstallationFiles === undefined) {
            // don't know when this would be necessary but apparently
            // it is, see https://github.com/Nexus-Mods/Vortex/issues/3684
            return;
          }
          queue = queue.then(() =>
            PromiseBB.map(
              entries,
              (entry) =>
                this.getFileId(entry).then((id) => {
                  if (id !== undefined) {
                    this.mInstallationFiles?.add(id);
                  }
                }),
              { concurrency: 50 },
            ).then(() => undefined),
          );
        },
        {
          details: true,
          skipHidden: false,
        },
      )
        .then(() => queue)
        .catch((err) =>
          ["ENOENT", "ENOTFOUND"].includes(err.code) ? PromiseBB.resolve() : PromiseBB.reject(err),
        )
        .then(() => PromiseBB.resolve(this.mInstallationFiles));
    }

    // now remove all files in the game directory that have the same id
    // as a file in the mods directory
    return installEntryProm.then((inos) => {
      const total = inos.size;
      let purged: number = 0;

      let queue = PromiseBB.resolve();
      if (inos.size === 0) {
        return PromiseBB.resolve();
      }
      return turbowalk(
        dataPath,
        (entries) => {
          queue = queue.then(() =>
            PromiseBB.map(
              entries,
              (entry) =>
                this.getFileId(entry).then((id) => {
                  if (id !== undefined && inos.has(id)) {
                    ++purged;
                    if (purged % 1000 === 0) {
                      onProgress?.(purged, total);
                    }
                    return fs
                      .unlinkAsync(entry.filePath)
                      .catch((err) => log("warn", "failed to remove", entry.filePath));
                  }
                  return PromiseBB.resolve();
                }),
              { concurrency: 50 },
            ).then(() => undefined),
          );
        },
        { details: true, skipHidden: false },
      ).then(() => queue);
    });
  }

  protected linkFile(linkPath: string, sourcePath: string, dirTags?: boolean): Promise<void> {
    return this.ensureDir(path.dirname(linkPath), dirTags)
      .then(() => fs.linkAsync(sourcePath, linkPath))
      .catch((err: unknown) =>
        getErrorCode(err) !== "EEXIST"
          ? Promise.reject(unknownToError(err))
          : fs.removeAsync(linkPath).then(() => fs.linkAsync(sourcePath, linkPath)),
      );
  }

  protected unlinkFile(linkPath: string): PromiseBB<void> {
    return fs.unlinkAsync(linkPath);
  }

  protected isLink(
    linkPath: string,
    sourcePath: string,
    linkStatsIn: fs.Stats,
    sourceStatsIn: fs.Stats,
  ): PromiseBB<boolean> {
    if (linkStatsIn !== undefined && sourceStatsIn !== undefined) {
      return PromiseBB.resolve(
        linkStatsIn.nlink > 1 &&
          linkStatsIn.dev === sourceStatsIn.dev &&
          linkStatsIn.ino === sourceStatsIn.ino,
      );
    }

    return fs
      .lstatAsync(linkPath)
      .then((linkStats) =>
        linkStats.nlink === 1
          ? PromiseBB.resolve(false)
          : fs
              .lstatAsync(sourcePath)
              .then(
                (sourceStats) =>
                  linkStats.dev === sourceStats.dev && linkStats.ino === sourceStats.ino,
              ),
      )
      .catch((err) =>
        getErrorCode(err) === "ENOENT"
          ? PromiseBB.resolve(false)
          : PromiseBB.reject(unknownToError(err)),
      );
  }

  protected canRestore(): boolean {
    return true;
  }
}

export interface IExtensionContextEx extends IExtensionContext {
  registerDeploymentMethod: (activator: IDeploymentMethod) => void;
}

function init(context: IExtensionContextEx): boolean {
  context.registerDeploymentMethod(new DeploymentMethod(context.api));

  return true;
}

export default init;
