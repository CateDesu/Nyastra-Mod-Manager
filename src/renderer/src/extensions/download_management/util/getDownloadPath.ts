import * as os from "os";
import * as path from "path";

import format from "string-template";

import getVortexPath from "../../../util/getVortexPath";
import makeCI from "../../../util/makeCaseInsensitive";

let userData: string;

export function getDownloadPathPattern(pattern: string): string {
  return pattern || path.join("{USERDATA}", "downloads");
}

function getDownloadPath(pattern: string, gameId?: string): string {
  if (userData === undefined) {
    userData = getVortexPath("userData");
  }
  const formatKeys = makeCI({
    userdata: userData,
    username: os.userInfo().username,
  });

  let result =
    gameId !== undefined && gameId !== "__invalid"
      ? path.join(format(getDownloadPathPattern(pattern), formatKeys), gameId)
      : format(getDownloadPathPattern(pattern), formatKeys);

  if (!path.isAbsolute(result)) {
    result = path.resolve(getVortexPath("userData"), result);
  }

  return result;
}

export default getDownloadPath;
