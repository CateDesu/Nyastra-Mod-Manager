import { realpath } from "node:fs/promises";
import * as path from "path";
import * as util from "util";

import { getErrorCode } from "@vortex/shared";
import PromiseBB from "bluebird";
import type { TFunction } from "i18next";
import type { IEntry } from "turbowalk";
import turbowalk from "turbowalk";

import { setSettingsPage } from "../../actions/session";
import type { IExtensionApi, IExtensionContext } from "../../types/IExtensionContext";
import type { IGame } from "../../types/IGame";
import { UserCanceled } from "../../util/CustomErrors";
import * as fs from "../../util/fs";
import { moveFileNoReplace } from "../../util/fsAtomic";
import { log } from "../../util/log";
import type { IDiscoveryResult } from "../gamemode_management/types/IDiscoveryResult";
import { getGame } from "../gamemode_management/util/getGame";
import type { IDeployment } from "../mod_management/LinkingDeployment";
import LinkingDeployment from "../mod_management/LinkingDeployment";
import { installPathForGame } from "../mod_management/selectors";
import type {
  IDeployedFile,
  IDeploymentMethod,
  IUnavailableReason,
} from "../mod_management/types/IDeploymentMethod";

const LNK_EXT = ".vortex_lnk";

interface ILinkData {
  target: string;
}

export class FileFound extends Error {
  constructor(name) {
    super(name);
    this.name = this.constructor.name;
  }
}

class DeploymentMethod extends LinkingDeployment {
  public priority: number = 50;

  private mLnkExpression = new RegExp(LNK_EXT + "$");

  constructor(api: IExtensionApi) {
    super(
      "move_activator",
      "Move deployment (Experimental!)",
      "Deploys mods by actually moving files to the destination directory.",
      false,
      api,
    );
  }

  public detailedDescription(t: TFunction): string {
    return t(
      "This deployment method doesn't use links but actually moves files to the destination " +
        "directory.\nFor every deployed file it creates a lnk file in the source location to " +
        "allow clean undeployment.\n" +
        "Advantages:\n" +
        " - perfect game compatibility\n" +
        " - no performance penalty\n" +
        " - perfect OS/FS support\n" +
        "Disadvantages:\n" +
        " - if mods aren't on the same partition as the game this will be extremely slow\n" +
        " - purging from a different vortex instance won't be possible\n" +
        " - easier to break since the game directory contains real files.",
    );
  }

  public isSupported(state: any, gameId: string, typeId: string): IUnavailableReason {
    const discovery: IDiscoveryResult = state.settings.gameMode.discovered[gameId];
    if (discovery === undefined || discovery.path === undefined) {
      return { description: (t) => t("Game not discovered.") };
    }

    const instPath = installPathForGame(state, gameId);

    const game: IGame = getGame(gameId);
    const modPaths = game.getModPaths(discovery.path);

    if (game.details?.supportsMoveActivator === false || game.compatible?.moveActivator === false) {
      return {
        description: (t) => t("Game doesn't support the move deployment method"),
      };
    }

    try {
      fs.accessSync(modPaths[typeId], fs.constants.W_OK);
    } catch (err) {
      log("info", "move deployment not supported due to lack of write access", {
        typeId,
        path: modPaths[typeId],
      });
      return {
        description: (t) => t("Can't write to output directory"),
        order: 3,
        solution: (t) =>
          t(
            "To resolve this problem, the current user account needs to " +
              'be given write permission to "{{modPath}}".',
            {
              replace: {
                modPath: modPaths[typeId],
              },
            },
          ),
      };
    }

    try {
      if (fs.statSync(instPath).dev !== fs.statSync(modPaths[typeId]).dev) {
        // actually we could support this but it would be so slow it wouldn't make sense

        return {
          description: (t) => t("Works only if mods are installed on the same drive as the game"),
          order: 8,
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
            new PromiseBB((resolve, reject) => {
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
        dir1: instPath || "undefined",
        dir2: modPaths[typeId],
        err: util.inspect(err),
      });
      return {
        description: (t) => t("Game not fully initialized yet, this should disappear soon."),
      };
    }

    return undefined;
  }

  public onSelected(api: IExtensionApi): PromiseBB<void> {
    return api
      .showDialog(
        "question",
        "Move Deployment",
        {
          text:
            'You\'re about to enable "Move Deployment".\n' +
            "Please note that move deployment is slightly slower, uses more disk space and is less " +
            'robust regarding changes from external applications than "Hardlink Deployment".\n' +
            "There are no advantages compared to hardlink deployment except that it also works " +
            "on exFAT/FAT32 formatted drives.\n" +
            "So please only use this if hardlink really is no option.",
        },
        [{ label: "Cancel" }, { label: "Continue" }],
      )
      .then((result) =>
        result.action === "Cancel" ? PromiseBB.reject(new UserCanceled()) : PromiseBB.resolve(),
      );
  }

  public finalize(
    gameId: string,
    dataPath: string,
    installationPath: string,
    progressCB?: (files: number, total: number) => void,
  ): PromiseLike<IDeployedFile[]> {
    const deployment: IDeployment = this.context.newDeployment;
    const extLen = LNK_EXT.length;
    this.context.newDeployment = Object.keys(deployment).reduce(
      (prev: IDeployment, relPath: string) => {
        if (path.extname(relPath).toLowerCase() === LNK_EXT) {
          deployment[relPath].relPath = deployment[relPath].relPath.slice(0, -extLen);
          prev[relPath.substr(0, relPath.length - extLen)] = deployment[relPath];
        } else {
          prev[relPath] = deployment[relPath];
        }
        return prev;
      },
      {},
    );

    return super.finalize(gameId, dataPath, installationPath, progressCB);
  }

  public deactivate(sourcePath: string, dataPath: string, sourceName: string): PromiseBB<void> {
    return turbowalk(
      sourcePath,
      (entries) => {
        if (this.context === undefined) {
          return;
        }
        entries.forEach((entry) => {
          if (!entry.isDirectory && path.extname(entry.filePath) === LNK_EXT) {
            const relPath: string = path.relative(
              sourcePath,
              entry.filePath.substring(0, entry.filePath.length - LNK_EXT.length),
            );
            const normPath = this.normalize(path.join(dataPath, relPath));
            if (
              this.context.newDeployment[normPath] !== undefined &&
              this.context.newDeployment[normPath].source === sourceName
            ) {
              delete this.context.newDeployment[normPath];
            }
          }
        });
      },
      { skipHidden: false, skipInaccessible: false },
    );
  }

  public getDeployedPath(input: string): string {
    if (path.extname(input) === LNK_EXT) {
      return input.substring(0, input.length - LNK_EXT.length);
    }
    return input;
  }

  protected purgeLinks(installationPath: string, dataPath: string): PromiseBB<void> {
    let links: IEntry[] = [];
    let purgeFailed = false;
    let purgeError: unknown;
    const directories = new Map<string, Promise<string>>();
    const resolveDirectory = (directory: string): Promise<string> => {
      if (!directories.has(directory)) {
        directories.set(
          directory,
          realpath(directory).catch((err) => {
            const parent = path.dirname(directory);
            if (getErrorCode(err) !== "ENOENT" || parent === directory) throw err;
            return resolveDirectory(parent).then((resolved) =>
              path.join(resolved, path.basename(directory)),
            );
          }),
        );
      }
      return directories.get(directory);
    };
    const isInside = (directory: string, target: string): boolean => {
      const relative = path.relative(directory, target);
      return (
        relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      );
    };

    // find lnk files in our mods directory
    return turbowalk(
      installationPath,
      (entries) => {
        links = links.concat(entries.filter((entry) => path.extname(entry.filePath) === LNK_EXT));
      },
      {
        details: true,
        skipHidden: false,
        skipInaccessible: false,
      },
    )
      .then(() =>
        PromiseBB.map(links, (entry) =>
          this.readLink(entry.filePath.slice(0, -LNK_EXT.length))
            .then(async (link) => {
              if (isInside(dataPath, link.target)) {
                return this.restoreLink(entry.filePath);
              }
              const [root, parent] = await Promise.all([
                resolveDirectory(dataPath),
                resolveDirectory(path.dirname(link.target)),
              ]);
              if (isInside(root, path.join(parent, path.basename(link.target)))) {
                return this.restoreLink(entry.filePath);
              }
            })
            .catch((err: unknown) => {
              if (!purgeFailed) purgeError = err;
              purgeFailed = true;
            }),
        ),
      )
      .then(() => {
        if (purgeFailed) throw purgeError;
      });
  }

  protected linkFile(linkPath: string, sourcePath: string, dirTags?: boolean): Promise<void> {
    if (path.extname(sourcePath) === LNK_EXT) {
      // sanity check, don't link the links
      return Promise.resolve();
    }
    const basePath = path.dirname(linkPath);
    return this.ensureDir(basePath).then(() => this.createLink(sourcePath, linkPath));
  }

  protected unlinkFile(linkPath: string, sourcePath: string): PromiseBB<void> {
    return this.restoreLink(sourcePath + LNK_EXT);
  }

  protected isLink(linkPath: string, sourcePath: string): PromiseBB<boolean> {
    return fs
      .readFileAsync(sourcePath + LNK_EXT, { encoding: "utf-8" })
      .then((data) => {
        try {
          if (JSON.parse(data).target !== linkPath) return false;
          // A staged file means the move did not finish or was changed externally.
          return fs
            .lstatAsync(sourcePath)
            .then(() => false)
            .catch((err) =>
              err.code === "ENOENT" ? PromiseBB.resolve(true) : PromiseBB.reject(err),
            );
        } catch (err) {
          log("error", "invalid link", { link: sourcePath + LNK_EXT, data });
          return false;
        }
      })
      .catch((err) => (err.code === "ENOENT" ? PromiseBB.resolve(false) : PromiseBB.reject(err)));
  }

  protected canRestore(): boolean {
    return true;
  }

  protected stat(filePath: string): PromiseBB<fs.Stats> {
    return fs
      .statAsync(filePath)
      .catch((err) =>
        err.code === "ENOENT" ? this.statVortexLink(filePath) : PromiseBB.reject(err),
      );
  }

  protected statLink(filePath: string): PromiseBB<fs.Stats> {
    return PromiseBB.resolve(fs.lstatAsync(filePath));
  }

  private readLink(filePath: string): PromiseBB<ILinkData> {
    return fs.readFileAsync(filePath + LNK_EXT, { encoding: "utf-8" }).then((data) => {
      try {
        const obj: ILinkData = JSON.parse(data);
        if (obj.target === undefined) {
          throw new Error("target missing");
        }
        return PromiseBB.resolve(obj);
      } catch (err) {
        const error: any = new Error("Invalid link");
        error.code = "ENOENT";
        error.path = filePath;
        return PromiseBB.reject(error);
      }
    });
  }

  private statVortexLink(filePath: string): PromiseBB<fs.Stats> {
    return this.readLink(filePath).then((linkInfo) => fs.statAsync(linkInfo.target));
  }

  private createLink(sourcePath: string, linkPath: string): PromiseBB<void> {
    const linkInfo = JSON.stringify({
      target: linkPath,
    });
    // if the sourcePath doesn't exist but a link placeholder, restore the link
    // first before creating it again
    return fs
      .statAsync(sourcePath)
      .catch({ code: "ENOENT" }, () =>
        fs.statAsync(sourcePath + LNK_EXT).then(() => this.restoreLink(sourcePath + LNK_EXT)),
      )
      .then(() =>
        fs
          .writeFileAsync(sourcePath + LNK_EXT, linkInfo, {
            encoding: "utf-8",
          })
          .then(() =>
            fs
              .statAsync(sourcePath)
              .then((stat) =>
                fs.utimesAsync(sourcePath + LNK_EXT, stat.atime as any, stat.mtime as any),
              ),
          )
          .then(() => fs.renameAsync(sourcePath, linkPath))
          .catch((err) =>
            // A failed move must not leave a placeholder claiming the target file.
            fs
              .removeAsync(sourcePath + LNK_EXT)
              .catch((cleanupError) => {
                log("warn", "failed to remove placeholder after deployment failure", {
                  path: sourcePath + LNK_EXT,
                  error: cleanupError.message,
                });
              })
              .then(() => PromiseBB.reject(err)),
          ),
      );
  }

  private restoreLink(linkPath: string): PromiseBB<void> {
    return fs.readFileAsync(linkPath, { encoding: "utf-8" }).then((data) => {
      try {
        const dat = JSON.parse(data);
        const outPath = linkPath.replace(this.mLnkExpression, "");
        return PromiseBB.resolve(moveFileNoReplace(dat.target, outPath))
          .catch((err) =>
            err.code === "ENOENT"
              ? // file was deleted. Well, the user is the boss...
                PromiseBB.resolve()
              : PromiseBB.reject(err),
          )
          .then(() => fs.removeAsync(linkPath));
      } catch (err) {
        log("error", "invalid link", { linkPath, data });
        const error: any = new Error("Invalid link");
        error.code = "ENOENT";
        error.path = linkPath;
        return PromiseBB.reject(error);
      }
    });
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
