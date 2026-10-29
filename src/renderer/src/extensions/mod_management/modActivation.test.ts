import * as fs from "node:fs";
import * as path from "node:path";

import { expect } from "vitest";

import { makeMod } from "../../test-utils/builders";
import { test } from "../../test-utils/deploymentTest";
import getNormalizeFunc from "../../util/getNormalizeFunc";
import { getGame } from "../gamemode_management/util/getGame";
import deployMods from "./modActivation";
import BlacklistSet from "./util/BlacklistSet";
import { normalizeDeployment } from "./util/deploymentNormalize";

for (const native of [false, true]) {
  test(`deployment respects mod priority and game casing, native=${native}`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ files: { "Textures/Armor.dds": "low priority" }, modName: "Low" });
    getGame("skyrimse").executable = () => (native ? "game.sh" : "game.exe");
    const high = path.join(h.stagingDir, "High", "textures", "armor.dds");
    fs.mkdirSync(path.dirname(high), { recursive: true });
    fs.writeFileSync(high, "high priority");
    const normalize = await getNormalizeFunc(h.gameDir);
    expect(normalize("Textures/Armor.dds")).not.toBe(normalize("textures/armor.dds"));
    const result = await deployMods(
      h.api,
      "skyrimse",
      h.stagingDir,
      h.gameDir,
      [
        makeMod({ id: "Low", installationPath: "Low" }),
        makeMod({ id: "High", installationPath: "High" }),
      ],
      h.method,
      [],
      "",
      new BlacklistSet([], getGame("skyrimse"), normalize),
      () => "",
    );
    expect(result).toHaveLength(native ? 2 : 1);
    expect(fs.readFileSync(h.inGame("textures/armor.dds"), "utf8")).toBe("high priority");
    if (native) {
      expect(fs.readFileSync(h.inGame("Textures/Armor.dds"), "utf8")).toBe("low priority");
    } else {
      expect(result[0].source).toBe("High");
      expect(fs.existsSync(h.inGame("Textures"))).toBe(false);
    }
    expect(await h.method.externalChanges("skyrimse", h.stagingDir, h.gameDir, result)).toEqual([]);
  });
}

test("file overrides and merge exclusions share the Windows output identity", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({
    files: {
      "textures/override.dds": "overridden",
      "textures/merged.dds": "merged",
      "textures/keep.dds": "keep",
    },
  });
  const normalize = normalizeDeployment("skyrimse", await getNormalizeFunc(h.gameDir));
  const result = await deployMods(
    h.api,
    "skyrimse",
    h.stagingDir,
    h.gameDir,
    [makeMod({ installationPath: "SomeMod", fileOverrides: [h.inGame("TEXTURES/OVERRIDE.DDS")] })],
    h.method,
    [],
    "",
    new BlacklistSet(["SomeMod/TEXTURES/MERGED.DDS"], getGame("skyrimse"), normalize),
    () => "",
  );
  expect(result.map((file) => file.relPath)).toEqual(["textures/keep.dds"]);
  expect(fs.readFileSync(h.inGame("textures/keep.dds"), "utf8")).toBe("keep");
  expect(fs.existsSync(h.inGame("textures/override.dds"))).toBe(false);
  expect(fs.existsSync(h.inGame("textures/merged.dds"))).toBe(false);
});
