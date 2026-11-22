import { randomUUID } from "node:crypto";
import * as path from "path";

import PromiseBB from "bluebird";
import type { TFunction } from "i18next";
import IniParser, { IniFile, WinapiFormat } from "vortex-parse-ini";

import { log } from "../../logging";
import type { IExtensionApi, IExtensionContext } from "../../types/IExtensionContext";
import type { IProfile, IState } from "../../types/IState";
import type { ITestResult } from "../../types/ITestResult";
import { UserCanceled } from "../../util/CustomErrors";
import deepMerge from "../../util/deepMerge";
import { disableErrorReport } from "../../util/errorHandling";
import * as fs from "../../util/fs";
import getVortexPath from "../../util/getVortexPath";
import { installPathForGame } from "../../util/selectors";
import { getSafe } from "../../util/storeHelper";
import { objDiff, setdefault } from "../../util/util";
import type { IDiscoveryResult } from "../gamemode_management/types/IDiscoveryResult";
import { INI_TWEAKS_PATH } from "../mod_management/InstallManager";
import type { IMod } from "../mod_management/types/IMod";
import type { IModWithState } from "../mod_management/types/IModProps";
import { NEXUS_DOMAIN } from "../nexus_integration/constants";
import { activeGameId } from "../profile_management/selectors";
import { iniFiles, iniFormat, optionalIniFiles } from "./gameSupport";
import renderINITweaks from "./TweakList";

function completeSettingsOperations<T>(
  items: T[],
  operation: (item: T) => PromiseLike<unknown>,
): PromiseBB<void> {
  // Keep the settings queue until every started file operation settles.
  return PromiseBB.map(items, (item) => PromiseBB.try(() => operation(item)).reflect()).then(
    (results) => {
      const failure = results.find((result) => result.isRejected());
      if (failure !== undefined) throw failure.reason();
    },
  );
}

interface IIniSnapshot {
  content: string;
  mode: number;
}

function cleanupIniBake(file: string): PromiseBB<void> {
  const record = file + ".baked.cleanup";
  const reservation = record + ".init";
  return fs
    .readFileAsync(record, "utf8")
    .catch({ code: "ENOENT" }, () => undefined)
    .then((token) => {
      if (token === undefined) return;
      if (
        token.length !== 36 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)
      )
        throw new Error("INI temporary cleanup data is invalid: " + record);
      const prefix = file + ".baked." + token;
      // Delete only names reserved by this file's recorded operation.
      return completeSettingsOperations(
        [
          prefix + ".tmp",
          file + ".baked.pending." + token + ".tmp",
          prefix + ".live.tmp",
          prefix + ".baked.tmp",
        ],
        (temporary) => fs.unlinkAsync(temporary).catch({ code: "ENOENT" }, () => undefined),
      ).then(() => fs.unlinkAsync(record));
    })
    .then(() =>
      // Initialization owns only this marker staging file, never INI temporary files.
      fs
        .lstatAsync(reservation)
        .then((stat) => {
          if (!stat.isDirectory())
            throw new Error("INI cleanup reservation is invalid: " + reservation);
          return fs.readdirAsync(reservation).then((names) => {
            if (names.some((name) => name !== "owner"))
              throw new Error("INI cleanup reservation contains unrelated files: " + reservation);
            return fs
              .unlinkAsync(path.join(reservation, "owner"))
              .catch({ code: "ENOENT" }, () => undefined)
              .then(() => fs.rmdirAsync(reservation));
          });
        })
        .catch({ code: "ENOENT" }, () => undefined),
    );
}

function withIniBakeTemporary<T>(
  file: string,
  operation: (prefix: string) => PromiseLike<T>,
): PromiseBB<T> {
  const token = randomUUID();
  const record = file + ".baked.cleanup";
  const reservation = record + ".init";
  let reserved = false;
  return cleanupIniBake(file)
    .then(() => fs.mkdirAsync(reservation))
    .then(() => {
      reserved = true;
      return fs
        .chmodAsync(reservation, 0o700)
        .then(() =>
          fs.writeFileAsync(path.join(reservation, "owner"), token, { flag: "wx", mode: 0o600 }),
        );
    })
    .then(() => fs.renameAsync(path.join(reservation, "owner"), record))
    .then(() => operation(file + ".baked." + token))
    .then(
      (result) => cleanupIniBake(file).return(result),
      (error) =>
        (reserved ? cleanupIniBake(file) : PromiseBB.resolve())
          .catch((cleanupError) => {
            log("warn", "Failed to clean INI temporary files", cleanupError);
          })
          .then(() => {
            throw error;
          }),
    );
}

function snapshotIni(file: string): PromiseBB<IIniSnapshot | null> {
  return PromiseBB.all([fs.readFileAsync(file), fs.statAsync(file)])
    .then(([content, stat]) => ({ content: content.toString("base64"), mode: stat.mode & 0o777 }))
    .catch({ code: "ENOENT" }, () => null);
}

function recoverIniBake(
  file: string,
  interrupted?: IIniSnapshot | null,
  temporaryPrefix?: string,
): PromiseBB<void> {
  const journal = file + ".baked.pending";
  return (temporaryPrefix === undefined ? cleanupIniBake(file) : PromiseBB.resolve())
    .then(() => fs.readFileAsync(journal, "utf8"))
    .catch({ code: "ENOENT" }, () => undefined)
    .then((content) => {
      if (content === undefined) return;
      if (temporaryPrefix === undefined)
        return withIniBakeTemporary(file, (prefix) => recoverIniBake(file, interrupted, prefix));
      const records = content.split("\n");
      const saved = JSON.parse(records[0]);
      const expected =
        interrupted !== undefined
          ? interrupted
          : records.length > 2
            ? JSON.parse(records[records.length - 2]).live
            : saved.candidate;
      if (
        saved.version !== 1 ||
        ![saved.live, saved.baked, expected].every(
          (snapshot) =>
            snapshot === null ||
            (typeof snapshot?.content === "string" &&
              Buffer.from(snapshot.content, "base64").toString("base64") === snapshot.content &&
              Number.isInteger(snapshot.mode) &&
              snapshot.mode >= 0 &&
              snapshot.mode <= 0o777),
        )
      ) {
        throw new Error("INI bake recovery data is invalid: " + journal);
      }
      return snapshotIni(file).then((current) => {
        if (current?.content !== saved.live?.content && current?.content !== expected?.content) {
          throw new Error("INI changed while bake recovery was pending: " + file);
        }
        return PromiseBB.each(
          [
            [file, saved.live],
            [file + ".baked", saved.baked],
          ] as [string, IIniSnapshot | null][],
          ([destination, snapshot]) =>
            snapshotIni(destination).then((current) => {
              if (current?.content === snapshot?.content && current?.mode === snapshot?.mode)
                return;
              if (snapshot === null)
                return fs.unlinkAsync(destination).catch({ code: "ENOENT" }, () => undefined);
              const temporary =
                temporaryPrefix + (destination === file ? ".live.tmp" : ".baked.tmp");
              return fs
                .writeFileAsync(temporary, Buffer.from(snapshot.content, "base64"), {
                  flag: "wx",
                  mode: 0o600,
                })
                .then(() => fs.chmodAsync(temporary, snapshot.mode))
                .then(() => fs.renameAsync(temporary, destination));
            }),
        ).then(() => fs.unlinkAsync(journal));
      });
    });
}

function publishIniBake(
  t: TFunction,
  file: string,
  candidate: string,
  source = file + ".baked",
): PromiseBB<void> {
  const journal = file + ".baked.pending";
  const prefix = candidate.slice(0, -".tmp".length);
  const temporary = journal + "." + candidate.slice((file + ".baked.").length);
  let prepared = false;
  return PromiseBB.all([snapshotIni(file), snapshotIni(file + ".baked"), snapshotIni(candidate)])
    .then(([live, baked, candidate]) =>
      fs.writeFileAsync(
        temporary,
        JSON.stringify({ version: 1, live, baked: baked ?? live, candidate }) + "\n",
        {
          flag: "wx",
          mode: 0o600,
        },
      ),
    )
    .then(() => fs.renameAsync(temporary, journal))
    .then(() => {
      prepared = true;
      return fs.forcePerm(t, () => fs.renameAsync(candidate, file + ".baked"));
    })
    .then(() => fs.copyAsync(source, prefix + ".live.tmp", { noSelfCopy: true }))
    .then(() => fs.forcePerm(t, () => fs.renameAsync(prefix + ".live.tmp", file)))
    .then(() => fs.unlinkAsync(journal))
    .catch((error) => {
      if (!prepared) throw error;
      // Atomic publication leaves only old or candidate bytes under our ownership.
      return recoverIniBake(file, undefined, prefix)
        .catch((recoveryError) => {
          throw new AggregateError(
            [error, recoveryError],
            "Failed to roll back INI baking: " + file,
          );
        })
        .then(() => {
          throw error;
        });
    });
}

function ensureIniBackups(
  t: TFunction,
  gameMode: string,
  discovery: IDiscoveryResult,
): PromiseBB<void> {
  return completeSettingsOperations(iniFiles(gameMode, discovery), (file) => {
    const backupFile = file + ".base";
    const bakedFile = file + ".baked";
    return completeSettingsOperations([backupFile, bakedFile], (copy) =>
      fs.statAsync(copy).catch(() =>
        fs
          .copyAsync(file, copy, { noSelfCopy: true })
          .then(() => fs.makeFileWritableAsync(copy))
          .catch((copyErr) => {
            if (copyErr.code === "ENOENT") {
              log("warn", "ini file missing", file);
              return PromiseBB.resolve();
            } else {
              return PromiseBB.reject(copyErr);
            }
          }),
      ),
    );
  });
}

function genIniFormat(format: string) {
  switch (format) {
    case "winapi":
      return new WinapiFormat();
    default:
      throw new Error("unsupported ini format: " + format);
  }
}

function applyDelta(data: any, delta: any) {
  if (typeof delta !== "object" || delta === null) {
    return;
  }

  Object.keys(delta).forEach((key) => {
    if (key[0] === "-") {
      delete data[key.slice(1)];
    } else if (key[0] === "+") {
      data[key.slice(1)] = delta[key];
    } else {
      if (data[key] === undefined) {
        data[key] = {};
      }
      applyDelta(data[key], delta[key]);
    }
  });
}

function missingOptionalFile(fileName: string, optionalFiles: string[]): PromiseBB<boolean> {
  if (!optionalFiles.includes(path.basename(fileName))) return PromiseBB.resolve(false);
  return fs
    .statAsync(fileName)
    .then(() => false)
    .catch({ code: "ENOENT" }, () => true);
}

/** Update the base INI with manual changes. */
function discoverSettingsChanges(
  api: IExtensionApi,
  gameMode: string,
  discovery: IDiscoveryResult,
  reportErrors: boolean = false,
  optionalFiles: string[] = [],
): PromiseBB<void> {
  const format = iniFormat(gameMode);
  if (format === undefined) {
    return PromiseBB.resolve();
  }

  const iniFormatter = genIniFormat(format);
  if (iniFormatter === undefined) {
    return PromiseBB.resolve();
  }

  const parser = new IniParser(iniFormatter);

  const t: TFunction = api.translate;

  const files = iniFiles(gameMode, discovery);
  const recovered = completeSettingsOperations(files, recoverIniBake).return(files);
  return PromiseBB.map(recovered, (iniFileName) => {
    let newContent: any;
    let oldContent: any;
    return PromiseBB.resolve(parser.read(iniFileName))
      .then((ini) => {
        newContent = ini.data;
        return parser.read(iniFileName + ".baked");
      })
      .then((ini) => {
        oldContent = ini.data;
        return parser.read(iniFileName + ".base");
      })
      .then((ini) => {
        const delta = objDiff(oldContent, newContent);
        // don't bother if there was no change
        if (Object.keys(delta).length === 0) {
          return PromiseBB.resolve();
        }
        applyDelta(ini.data, delta);
        return fs.forcePerm(t, () =>
          fs
            .openAsync(iniFileName + ".base", "a")
            .then((fd) => fs.closeAsync(fd))
            .then(() => parser.write(iniFileName + ".base", ini))
            // Important: Catching errors here means we go on to write the new ini file based
            //   on the old base data, reverting user changes. We should do this only if we know
            //   there are no user changes to keep (e.g. if the ini file had been removed for
            //   some reason). All other errors should be allowed to fail the bake process
            .catch({ code: "ENOENT" }, (err) => {
              if (reportErrors) throw err;
              api.showErrorNotification("Failed to write ini file", err, {
                allowReport: true,
                attachments: [
                  {
                    id: path.basename(iniFileName) + ".base",
                    type: "data",
                    data: delta,
                    description: "Ini file",
                  },
                ],
              });
            }),
        );
      })
      .catch({ code: "ENOENT" }, (err) =>
        missingOptionalFile(iniFileName, optionalFiles).then((missing) => {
          if (!missing) throw err;
        }),
      )
      .reflect();
  }).then((results) => {
    const failure = results.find((result) => result.isRejected());
    if (failure !== undefined) throw failure.reason();
  });
}

function getBaseFile(input: string): string {
  const match = input.match(/.*\[([^\]]*)\]\.ini/);
  if (match !== null && match.length >= 2) {
    return match[1] + ".ini";
  } else {
    return input;
  }
}

type ApplySettings = (fileName: string, parser: IniFile<any>) => PromiseBB<void>;

function bakeSettings(
  t: TFunction,
  gameMode: string,
  discovery: IDiscoveryResult,
  mods: IMod[],
  state: IState,
  onApplySettings: ApplySettings,
  optionalFiles: string[] = [],
): PromiseBB<void> {
  const modsPath = installPathForGame(state, gameMode);
  const format = iniFormat(gameMode);
  if (format === undefined) {
    return PromiseBB.resolve();
  }

  const iniFormatter = genIniFormat(format);
  if (iniFormatter === undefined) {
    return PromiseBB.resolve();
  }

  const enabledTweaks: { [baseFile: string]: string[] } = {};
  const optionalSettings = new Map<string, IniFile<any>>();

  const baseFiles = iniFiles(gameMode, discovery)
    // got an error report that I can only explain by baseFiles containing undefined
    // but I don't see how that could happen.
    .filter((name) => name !== undefined);
  const baseFileNames = baseFiles.map((name) => path.basename(name).toLowerCase());
  const parser = new IniParser(iniFormatter);

  // get a list of all tweaks we need to apply
  return PromiseBB.each(mods, (mod) => {
    if (mod.installationPath === undefined) {
      return PromiseBB.resolve();
    }
    const tweaksPath = path.join(modsPath, mod.installationPath, INI_TWEAKS_PATH);
    const modTweaks = getSafe(mod, ["enabledINITweaks"], []).map((name) => name.toLowerCase());
    return fs
      .readdirAsync(tweaksPath)
      .then((files) => {
        files
          .filter(
            (file) =>
              baseFileNames.includes(file.toLowerCase()) || modTweaks.includes(file.toLowerCase()),
          )
          .forEach((file) => {
            setdefault(enabledTweaks, getBaseFile(file.toLowerCase()), []).push(
              path.join(tweaksPath, file),
            );
          });
        return PromiseBB.resolve();
      })
      .catch({ code: "ENOENT" }, () => undefined);
  })
    .then(() =>
      PromiseBB.filter(baseFiles, (file) =>
        enabledTweaks[path.basename(file).toLowerCase()]?.length > 0
          ? PromiseBB.resolve(true)
          : missingOptionalFile(file, optionalFiles).then((missing) => {
              if (!missing) return true;
              const ini = new IniFile({});
              return onApplySettings(file, ini).then(() => {
                if (Object.keys(ini.data).length === 0) return false;
                optionalSettings.set(file, ini);
                return true;
              });
            }),
      ),
    )
    .then((files) =>
      PromiseBB.mapSeries(files, (iniFileName) => {
        const baseName = path.basename(iniFileName).toLowerCase();
        return withIniBakeTemporary(iniFileName, (prefix) => {
          const temporary = prefix + ".tmp";
          return missingOptionalFile(iniFileName, optionalFiles)
            .then((missing) => fs.ensureFileAsync(missing ? iniFileName + ".base" : iniFileName))
            .then(() =>
              PromiseBB.resolve(parser.read(iniFileName + ".base")).catch({ code: "ENOENT" }, () =>
                fs
                  .copyAsync(iniFileName, iniFileName + ".base", { noSelfCopy: true })
                  .then(() => fs.makeFileWritableAsync(iniFileName + ".base"))
                  .then(() => parser.read(iniFileName + ".base")),
              ),
            )
            .then((ini) =>
              PromiseBB.each(enabledTweaks[baseName] || [], (tweak) =>
                parser.read(tweak).then((patchIni) => {
                  ini.data = deepMerge(ini.data, patchIni.data);
                }),
              )
                .then(() => {
                  const supplied = optionalSettings.get(iniFileName);
                  if (supplied === undefined) return onApplySettings(iniFileName, ini);
                  ini.data = deepMerge(ini.data, supplied.data);
                })
                // Keep the last bake until every input and the new file are ready.
                .then(() =>
                  fs.forcePerm(t, () =>
                    fs
                      .copyAsync(iniFileName + ".base", temporary, { noSelfCopy: true })
                      .then(() => fs.makeFileWritableAsync(temporary))
                      .then(() => parser.write(temporary, ini)),
                  ),
                )
                .then(() => publishIniBake(t, iniFileName, temporary)),
            );
        });
      }),
    )
    .then(() => undefined);
}

function purgeChanges(t: TFunction, gameMode: string, discovery: IDiscoveryResult) {
  const optionalFiles = optionalIniFiles(gameMode, discovery);
  return completeSettingsOperations(iniFiles(gameMode, discovery), (iniFileName) => {
    return withIniBakeTemporary(iniFileName, (prefix) => {
      const temporary = prefix + ".tmp";
      return fs
        .copyAsync(iniFileName + ".base", temporary, {
          noSelfCopy: true,
        })
        .then(() => publishIniBake(t, iniFileName, temporary, iniFileName + ".base"))
        .catch({ code: "ENOENT" }, (err) =>
          missingOptionalFile(iniFileName, optionalFiles).then((missing) => {
            if (!missing) throw err;
          }),
        );
    });
  });
}

function main(context: IExtensionContext) {
  context.registerTableAttribute("mods", {
    id: "iniEdits",
    description: "Optional ini modifications",
    calc: () => "Dummy",
    customRenderer: (mod: IModWithState) => renderINITweaks(mod),
    placement: "detail",
    edit: {},
  });

  context.once(() => {
    let deactivated: boolean = false;
    let fallbackQueue = PromiseBB.resolve();
    const withSettings = <T>(operation: () => PromiseBB<T>): PromiseBB<T> => {
      let result: PromiseBB<T> | undefined;
      context.api.events.emit("game-settings-operation", operation, (pending: PromiseBB<T>) => {
        result = pending;
      });
      if (result !== undefined) return result;
      const pending = fallbackQueue.then(operation);
      fallbackQueue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    };

    context.api.events.on("gamemode-activated", (gameMode: string) => {
      const state: IState = context.api.store.getState();
      withSettings(() =>
        completeSettingsOperations(
          iniFiles(gameMode, state.settings.gameMode.discovered[gameMode]),
          recoverIniBake,
        ).then(() =>
          ensureIniBackups(
            context.api.translate,
            gameMode,
            state.settings.gameMode.discovered[gameMode],
          )
            .catch(UserCanceled, () => {
              log(
                "warn",
                "User has canceled creation of ini backups. Well, the user is boss I guess...",
                {
                  allowReport: false,
                },
              );
            })
            .catch((err) => {
              deactivated = true;
              if (err.code === "EINVAL" && err.path.toLowerCase().indexOf("onedrive") !== -1) {
                context.api.showErrorNotification(
                  "Failed to create backups of the ini files for this game.",
                  "Due to Microsoft using undocumented functionality for the new feature " +
                    '"OneDrive Files on Demand" the Node.js framework we use can not currently ' +
                    "work correctly on those drives. " +
                    `We therefore can't apply ini tweaks to '{{ filePath }}'.\n` +
                    "Please disable this feature and restart Vortex.\n" +
                    "Please keep an eye out on Vortex Changelogs so you know when this is fixed.",
                  {
                    allowReport: false,
                    replace: { filePath: err.path },
                  },
                );
              } else {
                context.api.showErrorNotification(
                  "Failed to create backups of the ini files for this game.",
                  {
                    message:
                      "To avoid data loss, ini tweaks are not going to be applied in this session.\n" +
                      "Please fix the problem and restart Vortex.",
                    error: err,
                  },
                );
              }
            }),
        ),
      ).catch((err) => {
        context.api.showErrorNotification("Failed to recover game settings", err);
      });
    });

    context.api.onAsync(
      "bake-settings",
      (
        gameId: string,
        mods: IMod[],
        profile: IProfile,
        options?: {
          reportResult?: boolean;
          optionalFiles?: string[];
          settingsLocked?: boolean;
          recoverOnly?: boolean;
        },
      ) => {
        const bake = () => {
          log("debug", "baking settings", { gameId, deactivated });
          if (deactivated) {
            return PromiseBB.resolve(
              options?.reportResult
                ? {
                    settingsBaked: false,
                    error: new Error("INI baking is unavailable in this session"),
                  }
                : undefined,
            );
          }
          const state: IState = context.api.store.getState();
          const current = state.persistent.profiles[profile.id];
          profile = {
            ...profile,
            ...current,
            features: {
              ...(current ?? profile).features,
              local_game_settings: profile.features?.local_game_settings,
            },
          };
          const discovery: IDiscoveryResult = state.settings.gameMode.discovered[profile.gameId];

          if (discovery === undefined || discovery.path === undefined) {
            return PromiseBB.resolve(
              options?.reportResult
                ? {
                    settingsBaked: false,
                    error: new Error("Game discovery is unavailable for INI baking"),
                  }
                : undefined,
            );
          }

          if (options?.recoverOnly) {
            return completeSettingsOperations(
              iniFiles(profile.gameId, discovery),
              recoverIniBake,
            ).then(() => ({ settingsBaked: true }));
          }

          const optionalFiles = [
            ...optionalIniFiles(profile.gameId, discovery),
            ...(options?.optionalFiles ?? []),
          ];

          const onApplySettings = (fileName: string, parser: IniFile<any>): PromiseBB<void> =>
            PromiseBB.resolve(
              context.api
                .emitAndAwait("apply-settings", profile, fileName, parser)
                .then(() => undefined),
            );

          return discoverSettingsChanges(
            context.api,
            profile.gameId,
            discovery,
            options?.reportResult,
            optionalFiles,
          )
            .then(() =>
              bakeSettings(
                context.api.translate,
                profile.gameId,
                discovery,
                mods,
                state,
                onApplySettings,
                optionalFiles,
              ),
            )
            .then(() => (options?.reportResult ? { settingsBaked: true } : undefined));
        };
        // Swaps already hold the queue while their final bake runs.
        return (options?.settingsLocked ? bake() : withSettings(bake))
          .catch(UserCanceled, (err) => {
            if (options?.reportResult) return { settingsBaked: false, error: err };
            // nop
            log("info", "user canceled baking game settings");
          })
          .catch((err) => {
            if (options?.reportResult) return { settingsBaked: false, error: err };
            const nonReportable = [362, 1359, "EBUSY"];
            const allowReport = !(
              err.stack.includes("not enough space on the disk") ||
              err.stack.includes("The cloud operation was unsuccessful") ||
              nonReportable.includes(err.systemCode) ||
              nonReportable.includes(err.errno) ||
              nonReportable.includes(err.code)
            );
            context.api.showErrorNotification("Failed to bake settings files", err, {
              allowReport,
            });
          });
      },
    );

    context.api.events.on("purge-mods", () => {
      if (deactivated) {
        return;
      }
      const state: IState = context.api.store.getState();
      const gameMode = activeGameId(state);
      const discovery: IDiscoveryResult = state.settings.gameMode.discovered[gameMode];
      withSettings(() =>
        discoverSettingsChanges(
          context.api,
          gameMode,
          discovery,
          false,
          optionalIniFiles(gameMode, discovery),
        ).then(() => purgeChanges(context.api.translate, gameMode, discovery)),
      )
        .catch(UserCanceled, () => {
          context.api.showErrorNotification("Ini files were not restored", undefined, {
            allowReport: false,
          });
        })
        .catch((err) => {
          context.api.showErrorNotification("Failed to purge ini edits", err, {
            allowReport: err.code !== "ENOENT",
          });
        });
    });
  });
}

export default main;
