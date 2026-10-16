import { beforeEach, describe, expect, it } from "vitest";

import { util } from "./__mocks__/vortex-api";
import { resolveBixPackage } from "./common";

const configuration = {
  gameId: "example",
  autoDownloadBepInEx: true,
  bepinexVersion: "5.4.23.2",
  bepinexCoercedVersion: "5.4.23",
};
const assets = [
  "BepInEx_linux_x64_5.4.23.2.zip",
  "BepInEx_linux_x86_5.4.23.2.zip",
  "BepInEx_macos_x64_5.4.23.2.zip",
  "BepInEx_win_x64_5.4.23.2.zip",
  "BepInEx_win_x86_5.4.23.2.zip",
];

beforeEach(() => util.getGame.mockReset());

describe("BepInEx download platform", () => {
  it.each([
    ["Game.exe", undefined, "BepInEx_win_x64_5.4.23.2.zip"],
    ["GAME.EXE", undefined, "BepInEx_win_x64_5.4.23.2.zip"],
    ["Start.cmd", undefined, "BepInEx_win_x64_5.4.23.2.zip"],
    ["Start.bat", undefined, "BepInEx_win_x64_5.4.23.2.zip"],
    ["Game.exe", "x86", "BepInEx_win_x86_5.4.23.2.zip"],
    ["Game.x86_64", undefined, "BepInEx_linux_x64_5.4.23.2.zip"],
    ["Game.x86", "x86", "BepInEx_linux_x86_5.4.23.2.zip"],
  ] as const)(
    "selects the loader for %s with architecture %s",
    (executable, architecture, archive) => {
      util.getGame.mockReturnValue({ executable: () => executable });
      const { rgx } = resolveBixPackage({ ...configuration, architecture });

      expect(assets.filter((asset) => rgx.test(asset))).toEqual([archive]);
      expect(util.getGame).toHaveBeenCalledWith(configuration.gameId);
    },
  );

  it("keeps the Linux default when the game is not registered", () => {
    const { rgx } = resolveBixPackage(configuration);

    expect(assets.filter((asset) => rgx.test(asset))).toEqual(["BepInEx_linux_x64_5.4.23.2.zip"]);
  });

  it("preserves older Windows archive names without a platform prefix", () => {
    util.getGame.mockReturnValue({ executable: () => "Game.exe" });
    const { rgx } = resolveBixPackage({
      ...configuration,
      bepinexVersion: "5.4.22.0",
      bepinexCoercedVersion: "5.4.22",
    });

    expect(rgx.test("BepInEx_x64_5.4.22.0.zip")).toBe(true);
  });
});
