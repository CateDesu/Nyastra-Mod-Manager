import * as fs from "fs";
import * as path from "path";

import getVortexPath from "../getVortexPath";
import { xdgDataHome } from "./xdg";

/**
 * Default Steam installation paths for Linux systems
 * Ordered by likelihood (most common first)
 */
export function getLinuxSteamPaths(): string[] {
  const home = getVortexPath("home");
  const candidates: string[] = [];
  try {
    candidates.push(fs.realpathSync(path.join(home, ".steam", "root")));
  } catch {
    // Steam has not created its root link.
  }
  candidates.push(
    path.join(xdgDataHome(), "Steam"),
    path.join(home, ".steam", "debian-installation"), // Debian/Ubuntu symlink
    path.join(home, ".var", "app", "com.valvesoftware.Steam", "data", "Steam"), // Flatpak
    path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
    path.join(home, "snap", "steam", "common", ".local", "share", "Steam"), // Snap
    path.join(home, ".steam", "steam"), // Legacy
  );
  return [...new Set(candidates)];
}

/**
 * Check if a path is a valid Steam installation
 */
export function isValidSteamPath(steamPath: string): boolean {
  const libraryFoldersPath = path.join(steamPath, "config", "libraryfolders.vdf");
  try {
    return fs.statSync(libraryFoldersPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the first valid Steam installation path on Linux
 */
export function findLinuxSteamPath(): string | undefined {
  for (const steamPath of getLinuxSteamPaths()) {
    if (isValidSteamPath(steamPath)) {
      return steamPath;
    }
  }
  return undefined;
}

export function findAllLinuxSteamPaths(): string[] {
  const roots = new Set<string>();
  for (const candidate of getLinuxSteamPaths()) {
    try {
      if (isValidSteamPath(candidate)) roots.add(fs.realpathSync(candidate));
    } catch {
      /* The installation disappeared during discovery. */
    }
  }
  return [...roots];
}
