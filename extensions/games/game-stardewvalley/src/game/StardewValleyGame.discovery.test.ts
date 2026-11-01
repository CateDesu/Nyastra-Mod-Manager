import { beforeEach, describe, expect, test, vi } from "vitest";

import StardewValleyGame from "./StardewValleyGame";

const { findByAppId, statAsync } = vi.hoisted(() => ({
  findByAppId: vi.fn(),
  statAsync: vi.fn(),
}));

vi.mock("@nexusmods/vortex-api", () => ({
  fs: { statAsync },
  util: { GameStoreHelper: { findByAppId } },
}));
vi.mock("../smapi/lifecycle", () => ({ deploySMAPI: vi.fn() }));
vi.mock("../smapi/selectors", () => ({ findSMAPIMod: vi.fn() }));
vi.mock("../smapi/workflow", () => ({ downloadAndInstallSMAPI: vi.fn() }));

describe("Stardew Valley discovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    findByAppId.mockRejectedValue(new Error("Fixture game is not installed"));
    statAsync.mockRejectedValue(Object.assign(new Error("Missing fixture"), { code: "ENOENT" }));
  });

  const makeGame = () => {
    const game = new StardewValleyGame({} as never);
    game.defaultPaths = ["/fixture/first", "/fixture/second"];
    return game;
  };

  test("returns a discovery miss when no installation exists", async () => {
    await expect(makeGame().queryPath()).resolves.toBeUndefined();
  });

  test("discovers the store installation before trying default paths", async () => {
    findByAppId.mockResolvedValue({ gamePath: "/fixture/store" });

    await expect(makeGame().queryPath()).resolves.toBe("/fixture/store");
    expect(statAsync).not.toHaveBeenCalled();
  });

  test("discovers an existing default path when store lookup misses", async () => {
    statAsync.mockRejectedValueOnce(new Error("Missing fixture")).mockResolvedValueOnce({});

    await expect(makeGame().queryPath()).resolves.toBe("/fixture/second");
  });
});
