import * as fs from "node:fs";
import * as path from "node:path";

import { expect } from "vitest";

import { test } from "../../test-utils/deploymentTest";
import type { IGame } from "../../types/IGame";
import getNormalizeFunc from "../../util/getNormalizeFunc";
import type { IDeployedFile } from "../mod_management/types/IDeploymentMethod";
import BlacklistSet from "../mod_management/util/BlacklistSet";

for (const upperCase of [false, true]) {
  for (const target of ["", "nested/output"]) {
    test(`move deployment keeps files across redeployment into ${target || "the game folder"}, uppercase normalization: ${upperCase}`, async ({
      makeDeployment,
    }) => {
      const h = makeDeployment({ method: "move", files: { "config.ini": "modded" } });
      const onDisk = await getNormalizeFunc(h.gameDir);
      const normalize = upperCase ? (input: string) => onDisk(input).toUpperCase() : onDisk;
      const blacklist = new BlacklistSet([], { details: {} } as IGame, normalize);
      const modDir = path.join(h.stagingDir, "SomeMod");
      const deploy = async (previous: IDeployedFile[]) => {
        await h.method.prepare(h.gameDir, true, previous, normalize);
        await h.method.activate(modDir, "SomeMod", target, blacklist);
        return h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
      };

      const first = await deploy([]);
      expect(fs.readFileSync(h.inGame(path.join(target, "config.ini")), "utf8")).toBe("modded");
      expect(fs.existsSync(path.join(modDir, "config.ini.vortex_lnk"))).toBe(true);

      const second = await deploy(first);
      expect(second).toEqual(first);
      expect(fs.readFileSync(h.inGame(path.join(target, "config.ini")), "utf8")).toBe("modded");

      await h.method.prepare(h.gameDir, false, second, normalize);
      await h.method.deactivate(modDir, target, "SomeMod");
      expect(await h.method.finalize("skyrimse", h.gameDir, h.stagingDir)).toEqual([]);
      expect(fs.existsSync(h.inGame(path.join(target, "config.ini")))).toBe(false);
      expect(fs.readFileSync(path.join(modDir, "config.ini"), "utf8")).toBe("modded");
      expect(fs.existsSync(path.join(modDir, "config.ini.vortex_lnk"))).toBe(false);
    });
  }
}
