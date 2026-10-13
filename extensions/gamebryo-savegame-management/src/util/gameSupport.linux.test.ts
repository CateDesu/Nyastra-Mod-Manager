import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { types } from "@nexusmods/vortex-api";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@nexusmods/vortex-api", async () => {
  const filesystem = await import("node:fs/promises");
  return {
    util: {
      getVortexPath: () => "/linux/Documents",
      makeOverlayableDictionary: (base: Record<string, Record<string, unknown>>) => ({
        get: (game: string, key: string) => base[game]?.[key],
      }),
    },
    selectors: { discoveryByGame: (state: { discovery: unknown }) => state.discovery },
    fs: { copyAsync: filesystem.copyFile, renameAsync: filesystem.rename },
  };
});
import { initGameSupport, mygamesPath } from "./gameSupport";
import transferSavegames from "./transferSavegames";
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("Linux savegame locations and transfers", () => {
  it("uses the discovered Proton prefix synchronously", () => {
    initGameSupport({
      store: {
        getState: () => ({
          discovery: {
            store: "steam",
            path: "/games/Skyrim",
            protonPrefix: "/library/steamapps/compatdata/489830/pfx",
          },
        }),
      },
    } as unknown as types.IExtensionApi);
    expect(mygamesPath("skyrimse")).toBe(
      "/library/steamapps/compatdata/489830/pfx/drive_c/users/steamuser/Documents/My Games/Skyrim Special Edition",
    );
  });
  it("uses Linux documents for a game without a Proton prefix", () => {
    initGameSupport({
      store: { getState: () => ({ discovery: { path: "/games/Skyrim" } }) },
    } as unknown as types.IExtensionApi);
    expect(mygamesPath("skyrimse")).toBe("/linux/Documents/My Games/Skyrim Special Edition");
  });
  it.each([true, false])(
    "transfers the save and script-extender companion with keepSource=%s",
    async (keepSource) => {
      directory = await mkdtemp(path.join(tmpdir(), "nyastra-saves-"));
      const source = path.join(directory, "source"),
        destination = path.join(directory, "destination");
      await mkdir(source);
      await mkdir(destination);
      await writeFile(path.join(source, "Astra.ess"), "save");
      await writeFile(path.join(source, "Astra.skse"), "companion");
      expect(
        await transferSavegames("skyrimse", ["Astra.ess"], source, destination, keepSource),
      ).toEqual([]);
      expect(await readFile(path.join(destination, "Astra.ess"), "utf8")).toBe("save");
      expect(await readFile(path.join(destination, "Astra.skse"), "utf8")).toBe("companion");
      if (keepSource) expect(await readFile(path.join(source, "Astra.ess"), "utf8")).toBe("save");
      else
        await expect(readFile(path.join(source, "Astra.ess"))).rejects.toMatchObject({
          code: "ENOENT",
        });
    },
  );
});
