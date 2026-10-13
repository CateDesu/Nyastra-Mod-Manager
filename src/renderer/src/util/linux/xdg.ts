import * as os from "node:os";
import * as path from "node:path";

function baseDirectory(variable: string, fallback: string): string {
  const value = process.env[variable];
  return value && path.isAbsolute(value) ? value : path.join(os.homedir(), fallback);
}

export const xdgDataHome = (): string => baseDirectory("XDG_DATA_HOME", ".local/share");
export const xdgConfigHome = (): string => baseDirectory("XDG_CONFIG_HOME", ".config");
export const xdgCacheHome = (): string => baseDirectory("XDG_CACHE_HOME", ".cache");
export const xdgStateHome = (): string => baseDirectory("XDG_STATE_HOME", ".local/state");
