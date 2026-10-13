import * as path from "path";

import PromiseBB from "bluebird";

import * as fs from "../../../util/fs";
import getVortexPath from "../../../util/getVortexPath";
import { deBOM, truthy } from "../../../util/util";

/**
 * return the path where chrome stores its settings regarding disabled schemes
 *
 * @returns
 */
function chromePath(): PromiseBB<string> {
  const appPath = getVortexPath("appData");
  let userData: string;
  {
    userData =
      process.platform === "linux"
        ? path.resolve(appPath, "google-chrome")
        : path.resolve(appPath, "Google", "Chrome");
  }
  return fs
    .readFileAsync(path.join(userData, "Local State"), { encoding: "utf-8" })
    .then((state) => {
      try {
        const dat = JSON.parse(deBOM(state));
        const prof =
          truthy(dat) && truthy(dat.profile) && truthy(dat.profile.last_used)
            ? dat.profile.last_used
            : "Default";
        return PromiseBB.resolve(path.join(userData, prof, "Preferences"));
      } catch (err) {
        return PromiseBB.reject(err);
      }
    })
    .catch((err) =>
      ["ENOENT", "EBUSY", "EPERM", "EISDIR"].indexOf(err.code) !== -1
        ? PromiseBB.resolve(path.join(userData, "Default", "Preferences"))
        : PromiseBB.reject(err),
    );
}

export default chromePath;
