import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import PromiseBB from "bluebird";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "../types/IExtensionContext";
import type { ISteamEntry, Steam } from "./Steam";

const catalog = vi.hoisted(() => ({
  allGames: vi.fn<() => Promise<ISteamEntry[]>>(),
  runToolWithProton: vi.fn<Steam["runToolWithProton"]>(),
}));
vi.mock("../extensions/gamemode_management/util/getGame", () => ({
  getGame: () => ({ id: "selected" }),
  getGameStoresSafe: () => [{ id: "steam", ...catalog }],
}));

import StarterInfo from "./StarterInfo";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nyastra-starter-proton-"));
  catalog.allGames.mockReset().mockResolvedValue([]);
  catalog.runToolWithProton.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function entry(gamePath: string, appid: string): ISteamEntry {
  return { gamePath, appid, name: `Game ${appid}`, gameStoreId: "steam", usesProton: true };
}

async function fixture(wrong = "Other Game", selected = "Game") {
  const wrongPath = path.join(root, wrong);
  const selectedPath = path.join(root, selected);
  const toolsPath = path.join(root, "External Tools");
  await Promise.all([mkdir(wrongPath), mkdir(selectedPath), mkdir(toolsPath)]);
  const entries = [entry(wrongPath, "11"), entry(selectedPath, "22")];
  catalog.allGames.mockResolvedValue(entries);
  const runExecutable = vi.fn(() => PromiseBB.resolve(null));
  const api = { runExecutable } as unknown as IExtensionApi;
  const onShowError = vi.fn();
  const tool = async (directory: string, workingDirectory = "") => {
    const exePath = path.join(directory, "mod-tool.exe");
    await writeFile(exePath, "selected tool fixture");
    return new StarterInfo(
      { id: "selected", name: "Selected game", executable: "game.exe", requiredFiles: [] },
      { path: selectedPath, store: "steam" },
      undefined,
      {
        id: "mod-tool",
        name: "Mod tool",
        path: exePath,
        hidden: false,
        custom: true,
        executable: () => "mod-tool.exe",
        requiredFiles: [],
        workingDirectory,
        parameters: ["--target", "two words"],
        environment: { TOOL_MODE: "test" },
        shell: false,
        detach: false,
      },
    );
  };
  return { selectedPath, toolsPath, entries, runExecutable, api, onShowError, tool };
}

describe("StarterInfo.run Proton selection", () => {
  for (const source of ["working directory", "executable"]) {
    it.each([
      ["unrelated directory control", "Other Game", "Game"],
      ["sibling directory with the same prefix", "Game", "Game Extended"],
      ["distinct Linux directory casing", "Game", "game"],
    ])(`selects the game through the ${source} with %s`, async (_label, wrong, selected) => {
      const f = await fixture(wrong, selected);
      const nested = path.join(f.selectedPath, "Mod Data");
      await mkdir(nested);
      const info =
        source === "working directory"
          ? await f.tool(f.toolsPath, nested)
          : await f.tool(nested, f.toolsPath);

      await StarterInfo.run(info, f.api, f.onShowError);

      expect(catalog.runToolWithProton).toHaveBeenCalledExactlyOnceWith(
        f.api,
        info.exePath,
        ["--target", "two words"],
        expect.objectContaining({ cwd: info.workingDirectory, env: { TOOL_MODE: "test" } }),
        f.entries[1],
      );
      expect(f.runExecutable).not.toHaveBeenCalled();
      expect(f.onShowError).not.toHaveBeenCalled();
    });
  }

  it("selects an external tool by its exact game working directory", async () => {
    const f = await fixture();
    const info = await f.tool(f.toolsPath, f.selectedPath + path.sep);

    await StarterInfo.run(info, f.api, f.onShowError);

    expect(catalog.runToolWithProton.mock.calls[0]?.[4]).toEqual(f.entries[1]);
    expect(f.runExecutable).not.toHaveBeenCalled();
  });

  it("selects by the executable when the configured working directory is empty", async () => {
    const f = await fixture();
    const info = await f.tool(f.selectedPath);

    await StarterInfo.run(info, f.api, f.onShowError);

    expect(catalog.runToolWithProton).toHaveBeenCalledExactlyOnceWith(
      f.api,
      info.exePath,
      info.commandLine,
      expect.objectContaining({ cwd: f.selectedPath }),
      f.entries[1],
    );
  });

  it("runs directly when neither path belongs to a catalog game", async () => {
    const f = await fixture();
    const info = await f.tool(f.toolsPath, f.toolsPath);

    await StarterInfo.run(info, f.api, f.onShowError);

    expect(catalog.runToolWithProton).not.toHaveBeenCalled();
    expect(f.runExecutable).toHaveBeenCalledExactlyOnceWith(
      info.exePath,
      ["--target", "two words"],
      expect.objectContaining({ cwd: f.toolsPath, env: { TOOL_MODE: "test" } }),
    );
    expect(f.onShowError).not.toHaveBeenCalled();
  });

  it.each(["native executable", "non-Steam tool", "non-Proton game", "catalog failure"])(
    "preserves direct execution for a %s",
    async (condition) => {
      const f = await fixture();
      const info = await f.tool(f.selectedPath);
      if (condition === "native executable") info.exePath = path.join(f.selectedPath, "tool");
      if (condition === "non-Steam tool") info.store = "manual";
      if (condition === "non-Proton game") f.entries[1].usesProton = false;
      if (condition === "catalog failure") {
        catalog.allGames.mockRejectedValue(new Error("catalog unavailable"));
      }

      await StarterInfo.run(info, f.api, f.onShowError);

      expect(catalog.runToolWithProton).not.toHaveBeenCalled();
      expect(f.runExecutable).toHaveBeenCalledExactlyOnceWith(
        info.exePath,
        info.commandLine,
        expect.objectContaining({ cwd: f.selectedPath }),
      );
      expect(f.onShowError).not.toHaveBeenCalled();
    },
  );
});
