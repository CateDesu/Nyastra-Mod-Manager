import * as fs from "node:fs";
import * as path from "node:path";

import { expect } from "vitest";

import { test } from "../../test-utils/deploymentTest";
import type { IGame } from "../../types/IGame";
import getNormalizeFunc from "../../util/getNormalizeFunc";
import type { IDeployedFile } from "../mod_management/types/IDeploymentMethod";
import BlacklistSet from "../mod_management/util/BlacklistSet";

for (const alias of ["none", "purge", "deploy"]) {
  test(`purging one move deployment path leaves other paths in place with alias: ${alias}`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ method: "move", files: { "config.ini": "modded" } });
    const modDir = path.join(h.stagingDir, "SomeMod");
    const otherModDir = path.join(h.stagingDir, "OtherMod");
    const selectedPath = h.inGame("selected");
    const aliasPath = h.inGame("selected-alias");
    const otherPath = h.inGame("selected-other");
    fs.mkdirSync(selectedPath);
    fs.writeFileSync(path.join(selectedPath, "config.ini"), "original");
    if (alias !== "none") fs.symlinkSync(selectedPath, aliasPath, "junction");
    fs.mkdirSync(otherModDir);
    fs.writeFileSync(path.join(otherModDir, "other.ini"), "other mod");
    const blacklist = new BlacklistSet([], { details: {} } as IGame, h.normalize);

    await h.method.prepare(h.gameDir, true, [], h.normalize);
    await h.method.activate(
      modDir,
      "SomeMod",
      alias === "deploy" ? "selected-alias" : "selected",
      blacklist,
    );
    await h.method.activate(otherModDir, "OtherMod", "selected-other", blacklist);
    await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);

    await h.method.purge(h.stagingDir, alias === "purge" ? aliasPath : selectedPath, "skyrimse");

    expect(fs.readFileSync(path.join(modDir, "config.ini"), "utf8")).toBe("modded");
    expect(fs.readFileSync(path.join(selectedPath, "config.ini"), "utf8")).toBe("original");
    expect(fs.existsSync(path.join(modDir, "config.ini.vortex_lnk"))).toBe(false);
    expect(h.dialogCalls).toEqual([]);
    expect(fs.readFileSync(path.join(otherPath, "other.ini"), "utf8")).toBe("other mod");
    expect(fs.existsSync(path.join(otherModDir, "other.ini.vortex_lnk"))).toBe(true);
    expect(fs.existsSync(path.join(otherModDir, "other.ini"))).toBe(false);
    await h.method.purge(h.stagingDir, otherPath, "skyrimse");
    expect(fs.readFileSync(path.join(otherModDir, "other.ini"), "utf8")).toBe("other mod");
    expect(fs.existsSync(path.join(otherPath, "other.ini"))).toBe(false);
    expect(fs.existsSync(path.join(otherModDir, "other.ini.vortex_lnk"))).toBe(false);
  });
}

test("move purge removes stale placeholders through an alias after a target folder is deleted", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ method: "move", files: { "nested/config.ini": "modded" } });
  const aliasPath = h.inGame("alias");
  const selectedPath = h.inGame("selected");
  const modDir = path.join(h.stagingDir, "SomeMod");
  fs.mkdirSync(selectedPath);
  fs.symlinkSync(selectedPath, aliasPath, "junction");
  const blacklist = new BlacklistSet([], { details: {} } as IGame, h.normalize);
  await h.method.prepare(h.gameDir, true, [], h.normalize);
  await h.method.activate(modDir, "SomeMod", "alias", blacklist);
  await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
  expect(fs.existsSync(path.join(modDir, "nested/config.ini.vortex_lnk"))).toBe(true);
  fs.rmSync(path.join(selectedPath, "nested"), { recursive: true });

  await h.method.purge(h.stagingDir, selectedPath, "skyrimse");

  expect(fs.existsSync(path.join(modDir, "nested/config.ini.vortex_lnk"))).toBe(false);
  expect(fs.existsSync(path.join(modDir, "nested/config.ini"))).toBe(false);
});

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
