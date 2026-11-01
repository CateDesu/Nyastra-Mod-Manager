import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { stat, rename, rm, readdir, readFile, mkdir } from "node:fs/promises";
import type * as NodeModule from "node:module";
import * as path from "node:path";

import { getErrorMessageOrDefault, unknownToError } from "@vortex/shared";
import SevenZip from "node-7z";
import * as semver from "semver";

import { addExtension, forgetExtension, removeExtension } from "../../actions";
import { isValidBcp47 } from "../../bcp47";
import ExtensionManager from "../../ExtensionManager";
import { log } from "../../logging";
import type { ExtensionType, ExtensionInfo, IAvailableExtension } from "../../types/extensions";
import type { IExtensionApi, IExtensionContext } from "../../types/IExtensionContext";
import type { IExtensionState, IState } from "../../types/IState";
import { DataInvalid, UserCanceled } from "../../util/CustomErrors";
import { withTrackedActivity } from "../../util/errorHandling";
import getVortexPath from "../../util/getVortexPath";
import { INVALID_FILENAME_RE } from "../../util/util";
import { webpackRequireHack } from "../../util/webpack-hacks";
import {
  emitExtensionInstalled,
  type ExtensionInstallSource,
} from "../analytics/mixpanel/extensionInstallAnalytics";
import { parseExtensionInfo } from "./extensionInfo";
import { findInstalled, findPreviousVersions } from "./queries";

interface ExtensionDependency {
  id: string;
  version?: string;
  optional: boolean;
}

class ContextProxyHandler implements ProxyHandler<any> {
  private mDependencies: ExtensionDependency[] = [];

  public get(target, key: PropertyKey): any {
    if (key === "requireExtension") {
      return (id: string, version?: string, optional = false) => {
        this.mDependencies.push({ id, version, optional });
      };
    } else if (key === "optional") {
      return new Proxy(
        {},
        {
          get() {
            return () => undefined;
          },
        },
      );
    } else if (key === "api") {
      return {
        translate: (input) => input,
      };
    } else {
      return () => undefined;
    }
  }

  public get dependencies(): ExtensionDependency[] {
    return this.mDependencies;
  }
}

function scanDependencies(api: IExtensionApi, extPath: string): ExtensionDependency[] {
  const handler = new ContextProxyHandler();
  const context = new Proxy<IExtensionContext>({} as IExtensionContext, handler);
  const entry = path.join(extPath, "index.js");
  const nativeRequire = (webpackRequireHack("node:module") as typeof NodeModule).createRequire(
    entry,
  );
  const realPath = realpathSync(extPath);
  const isLocal = (filename: string) =>
    filename.startsWith(extPath + path.sep) || filename.startsWith(realPath + path.sep);
  const previous = Object.entries(nativeRequire.cache).filter(([filename]) => isLocal(filename));
  const loaded = api.getLoadedExtensions().some((ext) => {
    if (path.resolve(ext.path) === extPath) return true;
    try {
      return realpathSync(ext.path) === realPath;
    } catch {
      return false;
    }
  });

  previous.forEach(([filename]) => delete nativeRequire.cache[filename]);

  try {
    const extension: unknown = nativeRequire(entry);
    const initFunc = ExtensionManager.getExtensionInitFunc(extension);
    if (initFunc === undefined) {
      log("warn", "extension has no init function, skipping dependency scan", {
        extPath,
      });

      return [];
    }

    initFunc(context);

    return handler.dependencies;
  } catch (unknownErr) {
    const err = unknownToError(unknownErr);
    // TODO: can't check for dependencies if the extension is already loaded
    //   and registers actions
    if (err.name === "TypeError" && err.message.startsWith("Duplicate action type")) return [];
    throw err;
  } finally {
    // Running extensions keep their original module objects and lazy requires.
    if (loaded) {
      Object.keys(nativeRequire.cache)
        .filter(isLocal)
        .forEach((key) => delete nativeRequire.cache[key]);
      previous.forEach(([filename, module]) => {
        nativeRequire.cache[filename] = module;
      });
    }
  }
}

const dependencyScans = new WeakMap<object, Set<Set<string>>>();

async function installExtensionDependencies(
  api: IExtensionApi,
  extension: IExtensionState,
  info: ExtensionInfo | undefined,
  dependencies: ExtensionDependency[],
): Promise<void> {
  const scans = dependencyScans.get(api.store) ?? new Set<Set<string>>();
  dependencyScans.set(api.store, scans);
  const identifiers = new Set([
    info?.id,
    info?.name,
    info?.id || path.basename(extension.path),
    // Catalog requests can return the same archive while its scan is still running.
    extension.name,
  ]);
  scans.add(identifiers);

  try {
    // Resolve each identifier once against all its required declarations.
    for (const id of new Set(dependencies.map((dependency) => dependency.id))) {
      const declarations = dependencies.filter((dependency) => dependency.id === id);
      const required = declarations.filter((dependency) => !dependency.optional);
      const optional = required.length === 0;
      const ranges = (optional ? declarations : required)
        .map((dependency) => dependency.version)
        .filter((version) => version !== undefined);
      const matchesVersion = (version: string | undefined) =>
        ranges.length === 0 ||
        (version !== undefined && ranges.every((range) => semver.satisfies(version, range)));
      const unmet = () =>
        new DataInvalid(
          `Extension dependency "${id}" requires ${ranges.join(" and ") || "an installed extension"}, but no compatible installation is available`,
        );
      const isSatisfied = async (): Promise<boolean> => {
        const loaded = api.getLoadedExtensions();
        const state = api.getState();
        const entries = state.app.extensions ?? {};
        const bundled = loaded.filter((ext) => ext.info?.bundled);
        const bundledPaths = new Set(bundled.map((ext) => path.normalize(ext.path)));
        const candidates: { name: string; info?: ExtensionInfo }[] = loaded.filter(
          (ext) => ext.dynamic === false,
        );
        const userNames = new Set<string>();
        for (const installed of Object.values(entries)) {
          if (
            installed.remove ||
            installed.enabled === false ||
            installed.path === undefined ||
            installed.bundled ||
            bundledPaths.has(path.normalize(installed.path))
          )
            continue;
          try {
            const installedInfo = parseExtensionInfo(
              JSON.parse(await readFile(path.join(installed.path, "info.json"), "utf8")),
            );
            const registeredName = installedInfo.id || path.basename(installed.path);
            candidates.push({ name: registeredName, info: installedInfo });
            userNames.add(registeredName);
          } catch {
            // Missing or invalid manifests cannot satisfy a requirement.
          }
        }
        for (const ext of bundled) {
          const recorded = findInstalled(entries, { path: ext.path })?.extension;
          const policy =
            recorded ?? (entries[ext.name]?.path === undefined ? entries[ext.name] : undefined);
          if (policy?.remove || policy?.enabled === false || userNames.has(ext.name)) continue;
          candidates.push(ext);
        }
        // The loader resolves the first matching registration, including manifest aliases.
        const candidate = candidates.find(
          (ext) => ext.name === id || ext.info?.id === id || ext.info?.name === id,
        );
        if (api.getState().app.extensions !== state.app.extensions) return isSatisfied();
        return candidate !== undefined && matchesVersion(candidate.info?.version);
      };

      try {
        if (ranges.some((range) => semver.validRange(range) === null)) throw unmet();
        if (await isSatisfied()) continue;

        const toInstall = (api.getState().session.extensions.available ?? [])
          .filter(
            (candidate) =>
              candidate.name === id &&
              semver.valid(candidate.version) !== null &&
              matchesVersion(candidate.version),
          )
          .toSorted((left, right) => semver.rcompare(left.version, right.version))[0];
        if (toInstall === undefined) throw unmet();
        // Compatible cycles are already satisfied by registration before scanning.
        // A conflicting cycle must fail rather than await its own install promise.
        if ([...scans].some((scan) => scan.has(id))) throw unmet();

        await api.emitAndAwait<"install-extension">("install-extension", toInstall);
        if (!(await isSatisfied())) throw unmet();
      } catch (err) {
        if (!optional) throw err;
        log("warn", "optional extension dependency unavailable", {
          id,
          ranges,
          error: getErrorMessageOrDefault(err),
        });
      }
    }
  } finally {
    scans.delete(identifiers);
    if (scans.size === 0) dependencyScans.delete(api.store);
  }
}

function sanitize(input: string): string {
  const temp = input.replace(INVALID_FILENAME_RE, "_");
  const ext = path.extname(temp);
  if ([".7z", ".zip", ".rar"].includes(ext.toLowerCase())) {
    return path.basename(temp, path.extname(temp));
  } else {
    return path.basename(temp);
  }
}

function canonicalDestination(destPath: string): string {
  try {
    return path.join(realpathSync(path.dirname(destPath)), path.basename(destPath));
  } catch {
    return path.resolve(destPath);
  }
}

/**
 * Clears the post-install `remove: true` flag for entries whose folder the new
 * install just renamed into place. Entries pointing at distinct, still-on-disk
 * folders keep their flag so the next startup's cleanup deletes them (#23295).
 */
export function clearStaleRemovalFlags(
  api: IExtensionApi,
  removedKeys: string[],
  destPath: string,
): void {
  const state: IState = api.getState();
  const extState = state.app.extensions ?? {};
  // Compare paths, not key strings: info.json `id` can decouple the state key
  // from the folder basename, and the archive-name fallback differs again.
  const normalizedDest = canonicalDestination(destPath);
  removedKeys.forEach((key) => {
    const prevPath = extState[key]?.path;
    if (prevPath !== undefined && canonicalDestination(prevPath) === normalizedDest) {
      api.store.dispatch(forgetExtension(key));
    }
  });
}

function removeOldVersion(api: IExtensionApi, catalogEntry: IAvailableExtension): string[] {
  const state = api.getState();
  const previousVersions = findPreviousVersions(state.app.extensions ?? {}, catalogEntry);

  if (previousVersions.length > 0) {
    log("info", "removing previous versions of the extension", {
      previousVersions,
    });
  }

  previousVersions.forEach(({ key }) => api.store.dispatch(removeExtension(key)));
  return previousVersions.map(({ key }) => key);
}

const requiredThemeFiles = ["variables.scss", "style.scss", "fonts.scss"];

/**
 * validate a theme extension. A theme extension can contain multiple themes, one directory
 * per theme, each is expected to contain at least one of
 * "variables.scss", "style.scss" or "fonts.scss"
 */
export async function validateTheme(extPath: string): Promise<void> {
  const entries = await readdir(extPath, { recursive: false, withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());

  if (directories.length === 0)
    throw new DataInvalid("Expected a subdirectory containing the stylesheets");
  const promises = directories.map(async (dir) => {
    const files = await readdir(path.join(dir.parentPath, dir.name), {
      recursive: false,
      withFileTypes: true,
    });
    const hasOneRequiredFile = !!requiredThemeFiles.find((required) =>
      files.find((x) => x.name === required),
    );
    if (!hasOneRequiredFile) throw new DataInvalid("Theme not found");
  });

  await Promise.all(promises);
}

/**
 * validate a translation extension. Can only contain one BCP 47 named directory
 * (other directories are ignored) which needs to contain at least one json file
 */
export async function validateTranslation(extPath: string): Promise<void> {
  const entries = await readdir(extPath, { withFileTypes: true });
  const languageDirectories = entries.filter(
    (entry) => entry.isDirectory() && isValidBcp47(entry.name),
  );
  if (languageDirectories.length !== 1)
    throw new DataInvalid("Expected exactly one language subdirectory");

  const languageDirectory = languageDirectories[0];

  const languageEntries = await readdir(
    path.join(languageDirectory.parentPath, languageDirectory.name),
    { withFileTypes: true },
  );
  const hasJSONFile = languageEntries.find((x) => x.isFile() && path.extname(x.name) === ".json");
  if (!hasJSONFile) throw new DataInvalid("No translation files");
}

/**
 * validate an extension. It has to contain an index.js and info.json on the top-level
 */
export async function validateExtension(extPath: string): Promise<void> {
  await Promise.all([stat(path.join(extPath, "index.js")), stat(path.join(extPath, "info.json"))]);
}

interface InstallAnalytics {
  source: ExtensionInstallSource;
  gameDomain?: string;
  gameName?: string;
}

export interface ExtensionRefresh {
  key: string;
  installed: IExtensionState;
}

export function refreshEntry(
  api: IExtensionApi,
  refresh: ExtensionRefresh,
): IExtensionState | undefined {
  const live = api.getState().app.extensions[refresh.key];
  return live?.path === refresh.installed.path &&
    live?.version === refresh.installed.version &&
    live?.modId === refresh.installed.modId &&
    live?.fileId === refresh.installed.fileId
    ? live
    : undefined;
}

interface InstallData {
  catalogEntry?: IAvailableExtension;
  analytics?: InstallAnalytics;
  refresh?: ExtensionRefresh;
}

// Concurrent install attempts of the same archive (e.g. the update check firing
// more than once) would extract into the same ".installing" directory
// simultaneously and fail with "Cannot delete output file ... being used by
// another process" (#23454). Dedupe them onto a single in-flight promise.
const activeInstalls: Map<string, Promise<void>> = new Map();
const destinationCommits = new Map<string, Promise<void>>();

async function commitToDestination<T>(destPath: string, commit: () => Promise<T>): Promise<T> {
  const key = canonicalDestination(destPath);
  const result = (destinationCommits.get(key) ?? Promise.resolve()).then(commit);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  destinationCommits.set(key, settled);
  try {
    return await result;
  } finally {
    if (destinationCommits.get(key) === settled) destinationCommits.delete(key);
  }
}

function installExtension(
  api: IExtensionApi,
  archivePath: string,
  data?: InstallData,
): Promise<void> {
  const extensionsPath = path.resolve(getVortexPath("userData"), "plugins");
  const key = extensionsPath + "\0" + path.resolve(archivePath);
  const active = activeInstalls.get(key);

  if (active !== undefined) {
    return active;
  }

  const result = installExtensionImpl(api, archivePath, extensionsPath, data).finally(() => {
    activeInstalls.delete(key);
  });

  activeInstalls.set(key, result);
  return result;
}

async function installExtensionImpl(
  api: IExtensionApi,
  archivePath: string,
  extensionsPath: string,
  data?: InstallData,
): Promise<void> {
  let destPath: string;
  const tempPath = path.join(extensionsPath, `.extension-${randomUUID()}.installing`);

  const extractor = new SevenZip();

  await mkdir(extensionsPath, { recursive: true });
  await withTrackedActivity(
    "vortex.extension-manager",
    "extension.install",
    {
      "extension.archive": path.basename(archivePath),
      "extension.name": data?.catalogEntry?.name,
      "extension.type": data?.catalogEntry?.type,
    },
    async () => {
      const result = await Promise.resolve(
        extractor.extractFull(archivePath, tempPath, { ssc: false }),
      );

      // node-7z can resolve (not reject) with a non-zero exit code or
      // a populated errors array on partial/failed extraction. Without
      // this check, validateInstall runs against an empty or partial
      // tempPath and we surface a misleading "needs index.js and
      // info.json on top-level" error instead of the real cause
      // (locked file, AV quarantine, corrupt download, etc.).
      const code = result?.code ?? 0;
      const errors = result?.errors ?? [];
      if (code !== 0 || errors.length > 0) {
        log(code !== 0 ? "error" : "warn", "extension extraction reported issues", {
          archivePath,
          tempPath,
          code,
          errors: errors.join("; "),
        });
      }

      if (code !== 0) {
        const detail = errors.length > 0 ? errors.join("; ") : `exit code ${code}`;
        throw new DataInvalid(`Failed to extract extension archive: ${detail}`);
      }

      const infoJsonPath = path.join(tempPath, "info.json");
      const isJavaScriptExtension = await validateExtension(tempPath)
        .then(() => true)
        .catch(() => false);

      let extensionInfo: ExtensionInfo | undefined = undefined;
      let guessedType: ExtensionType | undefined = undefined;

      // NOTE(erri120): themes and translations don't have an info.json file
      // only JavaScript extensions have one.
      if (isJavaScriptExtension) {
        const contents = await readFile(infoJsonPath, { encoding: "utf8" });
        extensionInfo = parseExtensionInfo(JSON.parse(contents));
      } else {
        const isTheme = await validateTheme(tempPath)
          .then(() => true)
          .catch(() => false);
        if (isTheme) {
          guessedType = "theme";
        } else {
          const isTranslation = await validateTranslation(tempPath)
            .then(() => true)
            .catch(() => false);
          if (isTranslation) {
            guessedType = "translation";
          } else {
            throw new DataInvalid(
              "Doesn't seem to contain a correctly packaged extension, theme or translation",
            );
          }
        }
      }

      const dirName = sanitize(extensionInfo?.id ?? path.basename(archivePath));
      if (dirName === "" || dirName === "." || dirName === "..") {
        throw new DataInvalid(`Invalid extension directory name: "${dirName}"`);
      }
      destPath = path.join(extensionsPath, dirName);

      const installed = await commitToDestination(destPath, async () => {
        if (data?.refresh !== undefined) {
          const live = refreshEntry(api, data.refresh);
          if (live === undefined || live.remove || live.enabled === false) throw new UserCanceled();
        }
        let removedKeys =
          data?.catalogEntry && !data.refresh ? removeOldVersion(api, data.catalogEntry) : [];

        // we don't actually expect the output directory to exist
        await rm(destPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        await rename(tempPath, destPath);

        // Keep choices made while native replacement was outstanding.
        const policy = data?.refresh === undefined ? undefined : refreshEntry(api, data.refresh);
        if (data?.refresh !== undefined && data.catalogEntry !== undefined) {
          removedKeys = removeOldVersion(api, data.catalogEntry);
        }
        // Retire every old owner of the committed directory, including manual installs.
        clearStaleRemovalFlags(api, Object.keys(api.getState().app.extensions ?? {}), destPath);

        const state: IExtensionState = {
          name: data?.catalogEntry?.name ?? extensionInfo?.name ?? path.basename(destPath),
          author: data?.catalogEntry?.author ?? extensionInfo?.author ?? "<unknown>",
          description: extensionInfo?.description ?? "<missing>",
          version: data?.catalogEntry?.version ?? extensionInfo?.version ?? "0.0.1",

          endorsed: "Undecided",
          remove: data?.refresh === undefined ? false : (policy?.remove ?? true),
          enabled: data?.refresh === undefined ? true : (policy?.enabled ?? false),
          path: destPath,

          infoJsonId: extensionInfo?.id,

          modId: data?.catalogEntry?.modId,
          fileId: data?.catalogEntry?.fileId,
          type: data?.catalogEntry?.type ?? guessedType,
        };

        api.store.dispatch(addExtension(state));

        emitExtensionInstalled(api, state, {
          source: data?.analytics?.source,
          isUpdate: removedKeys.length > 0,
          gameDomain: data?.analytics?.gameDomain,
          gameName: data?.analytics?.gameName,
        });

        if (
          state.remove ||
          state.enabled === false ||
          state.type === "theme" ||
          state.type === "translation"
        )
          return undefined;

        // Capture this commit's requirements before another archive replaces its bytes.
        return { state, dependencies: scanDependencies(api, state.path) };
      });

      if (installed !== undefined) {
        await installExtensionDependencies(
          api,
          installed.state,
          extensionInfo,
          installed.dependencies,
        );
      }
    },
  ).finally(() => rm(tempPath, { recursive: true, force: true, maxRetries: 3 }));
}

export default installExtension;
