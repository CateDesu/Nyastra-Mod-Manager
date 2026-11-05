import * as path from "node:path";

import { Minimatch } from "minimatch";

import type { IGame } from "../../../types/IGame";
import type { Normalize } from "../../../util/getNormalizeFunc";
import { DEPLOY_BLACKLIST } from "../constants";
import type { IMod } from "../types/IMod";

export function fileOverrideEntries(
  mod: IMod,
  destinationPath: string,
  normalize: Normalize,
): string[] {
  return (mod.fileOverrides ?? []).map((file) =>
    normalize(path.join(mod.installationPath, path.relative(destinationPath, file))),
  );
}

export default class BlacklistSet extends Set<string> {
  private mPatterns: Minimatch[];
  constructor(blacklist: string[], game: IGame, normalize: Normalize) {
    super(blacklist.filter((x) => !!x).map((iter) => normalize(iter)));
    const patterns = DEPLOY_BLACKLIST.concat(game.details?.ignoreDeploy ?? []);
    this.mPatterns = patterns
      .filter((pattern) => !!pattern)
      .flatMap((pattern) => {
        try {
          return [new Minimatch(normalize(pattern), { nocase: true, dot: true })];
        } catch {
          return [];
        }
      });
  }

  public has(value: string): boolean {
    if (!value) {
      return false;
    }
    try {
      return super.has(value) || this.mPatterns.some((pattern) => pattern.match(value));
    } catch {
      return false;
    }
  }
}
