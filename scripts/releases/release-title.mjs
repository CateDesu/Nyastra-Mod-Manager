import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatProgramVersion,
  packageVersionFromRelease,
} from "../../src/shared/src/programVersion.ts";

export function releaseTitle(version) {
  const title = formatProgramVersion(version);
  if (title === version || packageVersionFromRelease(title) !== version)
    throw new Error("Release versions require 2.9.0 through 2.9.999 for v1.00 through v1.999");
  return `v${title}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  console.log(releaseTitle(process.argv[2]));
