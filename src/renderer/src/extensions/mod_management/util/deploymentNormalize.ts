import type { Normalize } from "../../../util/getNormalizeFunc";
import { getGame } from "../../gamemode_management/util/getGame";

export function isWindowsGame(gameId: string, normalize?: Normalize): boolean {
  if (process.platform !== "linux") return false;
  const game = getGame(gameId);
  if (game?.executable) {
    try {
      return /\.(exe|bat|cmd)$/i.test(game.executable());
    } catch {
      return false;
    }
  }
  return normalize !== undefined && normalize("A") === normalize("a");
}

export function normalizeDeployment(gameId: string, normalize: Normalize): Normalize {
  return isWindowsGame(gameId, normalize)
    ? (filename) => normalize(filename).toUpperCase()
    : normalize;
}
