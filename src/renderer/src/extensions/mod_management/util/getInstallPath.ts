import * as os from "os";
import * as path from "path";

import format from "string-template";

import getVortexPath from "../../../util/getVortexPath";
import makeCI from "../../../util/makeCaseInsensitive";

export function getInstallPathPattern(pattern: string): string {
  return pattern || path.join("{USERDATA}", "{GAME}", "mods");
}

export function resolveInstallPath(input: string, gameId: string) {
  const formatKeys = makeCI({
    userdata: getVortexPath("userData"),
    username: os.userInfo().username,
    game: gameId,
  });

  return format(input, formatKeys);
}

function getInstallPath(pattern: string, gameId: string): string {
  if (gameId === undefined) {
    throw new Error("gameId can't be undefined");
  }
  let result = resolveInstallPath(getInstallPathPattern(pattern), gameId);

  if (!path.isAbsolute(result)) {
    result = path.resolve(getVortexPath("userData"), result);
  }

  return result;
}

export default getInstallPath;
