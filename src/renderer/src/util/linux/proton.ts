import * as path from "path";

import { parse } from "simple-vdf";

import * as fs from "../fs";
import { log } from "../log";

export interface IProtonInfo {
  usesProton: boolean;
  compatDataPath?: string;
  protonPath?: string;
}

export const PROTON_USERNAME = "steamuser";

export function getMyGamesPath(compatDataPath: string): string {
  return path.join(
    compatDataPath,
    "pfx",
    "drive_c",
    "users",
    PROTON_USERNAME,
    "Documents",
    "My Games",
  );
}

/**
 * Check if a game uses Proton by looking for its compatdata folder
 */
export async function detectProtonUsage(steamAppsPath: string, appId: string): Promise<boolean> {
  const compatDataPath = path.join(steamAppsPath, "compatdata", appId);
  try {
    await fs.statAsync(compatDataPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the compatdata path for a game
 */
export function getCompatDataPath(steamAppsPath: string, appId: string): string {
  return path.join(steamAppsPath, "compatdata", appId);
}

/**
 * Get the Wine prefix path within compatdata
 */
export function getWinePrefixPath(compatDataPath: string): string {
  return path.join(compatDataPath, "pfx");
}

/**
 * Read Steam's config.vdf to find the configured Proton version for a game
 */
export async function getConfiguredProtonName(
  steamPath: string,
  appId: string,
): Promise<string | undefined> {
  const configPath = path.join(steamPath, "config", "config.vdf");
  try {
    const configData = await fs.readFileAsync(configPath, "utf8");
    const config = parse(configData.toString()) as any;
    const mapping = config?.InstallConfigStore?.Software?.Valve?.Steam?.CompatToolMapping;
    return mapping?.[appId]?.name ?? mapping?.["0"]?.name;
  } catch (err: any) {
    log("debug", "Could not read Steam config.vdf", { error: err?.message });
    return undefined;
  }
}

/**
 * Ignore incomplete downloads without a Proton runner.
 */
async function isProtonInstallation(directory: string): Promise<boolean> {
  try {
    return (await fs.statAsync(path.join(directory, "proton"))).isFile();
  } catch {
    return false;
  }
}

function protonCommonPaths(steamPath: string, libraryPaths: readonly string[]): string[] {
  return [...new Set([steamPath, ...libraryPaths])].map((libraryPath) =>
    path.join(libraryPath, "steamapps", "common"),
  );
}

/**
 * Extract a searchable keyword from a Proton config name.
 * Config names use formats like "proton_experimental", "proton_9", "proton_hotfix".
 * Returns the portion after "proton_" for fuzzy matching against folder names.
 */
function extractProtonKeyword(protonName: string): string | undefined {
  const lower = protonName.toLowerCase();
  if (!lower.startsWith("proton_")) {
    return undefined;
  }
  return lower.slice("proton_".length);
}

/**
 * Check if a folder name matches a Proton keyword via fuzzy matching.
 * Handles cases like: "proton_experimental" -> "Proton - Experimental"
 *                     "proton_9" -> "Proton 9.0"
 *                     "proton_hotfix" -> "Proton Hotfix"
 */
function folderMatchesKeyword(folderName: string, keyword: string): boolean {
  const lowerFolder = folderName.toLowerCase();

  // Version number match: "9" should match "9.0", "9.1", etc.
  if (/^\d+$/.test(keyword)) {
    return lowerFolder.match(/^proton[\s_-]*(\d+)(?:[.\s_-]|$)/)?.[1] === keyword;
  }

  return lowerFolder.includes(keyword);
}

/**
 * Resolve a Proton config name to its installation path.
 *
 * Steam stores the configured Proton version in config.vdf using internal names
 * (e.g., "proton_experimental", "proton_9", "GE-Proton10-28"), but the actual
 * installation folders use different naming conventions:
 *   - config.vdf: "proton_experimental" -> folder: "Proton - Experimental"
 *   - config.vdf: "proton_9"            -> folder: "Proton 9.0"
 *   - config.vdf: "GE-Proton10-28"      -> folder: "GE-Proton10-28" (exact match)
 *
 * Steam provides no direct mapping between these names. Custom tools (GE-Proton, etc.)
 * use matching names, but official Proton versions do not.
 *
 * Resolution strategy (no hardcoded mappings):
 * 1. Custom tools: Check compatibilitytools.d/{name} - custom Proton builds
 *    use their config name as the folder name directly.
 * 2. Exact match: Check every library's steamapps/common/{name}.
 * 3. Fuzzy match: Scan each library's steamapps/common/Proton* folders.
 *    Extract the keyword after "proton_" and find a folder containing it.
 *
 * This approach is self-maintaining and doesn't require updates when Valve
 * releases new Proton versions.
 */
export async function resolveProtonPath(
  steamPath: string,
  protonName: string,
  libraryPaths: readonly string[] = [],
): Promise<string | undefined> {
  // 1. Check custom compatibility tools directory (GE-Proton, etc.)
  // Custom tools use their config name as the folder name directly
  const customToolPath = path.join(steamPath, "compatibilitytools.d", protonName);
  if (await isProtonInstallation(customToolPath)) {
    return customToolPath;
  }

  const commonPaths = protonCommonPaths(steamPath, libraryPaths);
  for (const commonPath of commonPaths) {
    const exactPath = path.join(commonPath, protonName);
    if (await isProtonInstallation(exactPath)) {
      return exactPath;
    }
  }

  const keyword = extractProtonKeyword(protonName);
  if (!keyword) {
    return undefined;
  }

  for (const commonPath of commonPaths) {
    try {
      const entries = await fs.readdirAsync(commonPath);
      const protonDirs = entries.filter((e) => e.toLowerCase().startsWith("proton"));

      for (const dir of protonDirs) {
        const protonPath = path.join(commonPath, dir);
        if (folderMatchesKeyword(dir, keyword) && (await isProtonInstallation(protonPath))) {
          return protonPath;
        }
      }
    } catch (err: any) {
      log("debug", "Could not scan steamapps/common for Proton", {
        error: err?.message,
      });
    }
  }

  return undefined;
}

/**
 * Find the latest installed Proton version (fallback)
 */
export async function findLatestProton(
  steamPath: string,
  libraryPaths: readonly string[] = [],
): Promise<string | undefined> {
  const candidates: string[] = [];
  for (const commonPath of protonCommonPaths(steamPath, libraryPaths)) {
    try {
      const entries = await fs.readdirAsync(commonPath);
      for (const entry of entries) {
        const protonPath = path.join(commonPath, entry);
        if (entry.toLowerCase().startsWith("proton") && (await isProtonInstallation(protonPath))) {
          candidates.push(protonPath);
        }
      }
    } catch (err: any) {
      log("debug", "Could not scan for Proton versions", { error: err?.message });
    }
  }
  return candidates.sort((left, right) =>
    path.basename(right).localeCompare(path.basename(left), "en", { numeric: true }),
  )[0];
}

/**
 * Get full Proton info for a game
 */
export async function getProtonInfo(
  steamPath: string,
  steamAppsPath: string,
  appId: string,
  libraryPaths: readonly string[] = [],
  oslist?: string,
): Promise<IProtonInfo> {
  const existingPrefix = await detectProtonUsage(steamAppsPath, appId);
  const usesProton =
    existingPrefix ||
    (typeof oslist === "string" &&
      oslist.trim().length > 0 &&
      !oslist.split(/[,\s]+/).some((os) => os.toLowerCase() === "linux"));
  if (!usesProton) {
    return { usesProton: false };
  }

  const compatDataPath = getCompatDataPath(steamAppsPath, appId);
  const searchPaths = [...libraryPaths, path.dirname(steamAppsPath)];

  // Try to get configured Proton, fall back to latest
  const protonName = await getConfiguredProtonName(steamPath, appId);
  let protonPath: string | undefined;

  if (protonName) {
    protonPath = await resolveProtonPath(steamPath, protonName, searchPaths);
  }

  if (!protonPath) {
    protonPath = await findLatestProton(steamPath, searchPaths);
  }

  return { usesProton: true, compatDataPath, protonPath };
}

/**
 * Check if a file is a Windows executable
 */
export function isWindowsExecutable(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".exe", ".bat", ".cmd"].includes(ext);
}

/**
 * Build environment variables for running through Proton
 */
export function buildProtonEnvironment(
  compatDataPath: string,
  steamPath: string,
  existingEnv?: Record<string, string>,
  appId?: string,
): Record<string, string> {
  const preloads = [
    path.join(steamPath, "ubuntu12_32", "gameoverlayrenderer.so"),
    path.join(steamPath, "ubuntu12_64", "gameoverlayrenderer.so"),
  ];
  return {
    ...existingEnv,
    ...(appId ? { SteamAppId: appId, SteamGameId: appId } : {}),
    STEAM_COMPAT_DATA_PATH: compatDataPath,
    STEAM_COMPAT_CLIENT_INSTALL_PATH: steamPath,
    WINEPREFIX: getWinePrefixPath(compatDataPath),
    LD_PRELOAD: preloads.join(":"),
  };
}

/**
 * Build the command to run an executable through Proton
 */
export function buildProtonCommand(
  protonPath: string,
  exePath: string,
  args: string[],
): { executable: string; args: string[] } {
  return {
    executable: path.join(protonPath, "proton"),
    args: ["run", exePath, ...args],
  };
}
