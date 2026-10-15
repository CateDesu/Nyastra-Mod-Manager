import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import * as exeVersion from "exe-version";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as iniParser from "vortex-parse-ini";

import { ProcessCanceled, UserCanceled } from "@/util/CustomErrors";

const games = [
  "darkestdungeon",
  "dawnofman",
  "divinityoriginalsin2",
  "dragonage",
  "dragonage2",
  "enderal",
  "fallout3",
  "fallout4",
  "fallout4vr",
  "galciv3",
  "gardenpaws",
  "grimdawn",
  "monster-hunter-world",
  "mount-and-blade",
  "neverwinter-nights",
  "neverwinter-nights2",
  "oblivion",
  "oni",
  "pathfinderkingmaker",
  "prisonarchitect",
  "sims3",
  "sims4",
  "skyrim",
  "skyrimvr",
  "survivingmars",
  "sw-kotor",
  "teamfortress2",
  "teso",
  "torchlight2",
  "vtmbloodlines",
  "witcher",
  "witcher2",
  "worldoftanks",
  "x4foundations",
];
let temporary: string | undefined;
afterEach(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = undefined;
});

interface IGameDefinition {
  id: string;
  queryPath?: () => PromiseLike<string | { gamePath: string }>;
  setup?: (discovery: { path: string }) => PromiseLike<void>;
}

function loadGame(slug: string, root = "/disposable/game") {
  const filename = path.resolve("../../extensions/games", `game-${slug}`, "src/index.js");
  const nativeRequire = createRequire(filename);
  const registered: IGameDefinition[] = [];
  const findByAppId = vi.fn(async () => ({ appid: "test", gamePath: root, gameStoreId: "steam" }));
  const findByName = vi.fn(async () => ({ appid: "test", gamePath: root, gameStoreId: "steam" }));
  const dispatch = vi.fn();
  const fs = {
    ...nativeRequire("fs-extra"),
    statAsync: stat,
    ensureDirWritableAsync: (folder: string) => mkdir(folder, { recursive: true }),
  };
  const api = {
    actions: new Proxy(
      {},
      {
        get:
          () =>
          (...args: unknown[]) => ({ args }),
      },
    ),
    fs,
    log: vi.fn(),
    selectors: {},
    util: {
      GameStoreHelper: { findByAppId, findByName },
      steam: { findByAppId, findByName },
      ProcessCanceled,
      UserCanceled,
      getVortexPath: () => root,
    },
  };
  const module = { exports: {} as { default?: (context: unknown) => void } };
  const require = (id: string) => {
    if (id === "vortex-api" || id === "@nexusmods/vortex-api") return api;
    if (id === "exe-version") return exeVersion;
    if (id === "vortex-parse-ini") return iniParser;
    // The removed binding must really fail if a module still tries to load it.
    return nativeRequire(id);
  };
  vm.runInNewContext(
    readFileSync(filename, "utf8"),
    {
      module,
      exports: module.exports,
      require,
      process,
      console,
      Buffer,
      __dirname: path.dirname(filename),
      __filename: filename,
    },
    { filename },
  );
  const context = new Proxy(
    {
      api: { store: { dispatch }, getState: () => ({ settings: {}, persistent: {} }) },
      registerGame: (game: IGameDefinition) => registered.push(game),
      registerGameStub: (game: IGameDefinition) => registered.push(game),
    },
    { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) },
  );
  module.exports.default(context);
  return { registered, findByAppId, findByName, dispatch, fs };
}

describe("bundled game registration on Linux", () => {
  it.each(games)(
    "loads %s and registers its games without the Windows registry binding",
    (slug) => {
      expect(loadGame(slug).registered.length).toBeGreaterThan(0);
    },
  );

  it.each([
    ["sims3", "47890"],
    ["witcher2", "20920"],
    ["teamfortress2", "440"],
  ])("discovers %s through its existing Steam app ID %s", async (slug, appId) => {
    const loaded = loadGame(slug);
    const result = await loaded.registered[0].queryPath();
    expect(result).toBe("/disposable/game");
    expect(loaded.findByAppId).toHaveBeenCalledWith(appId, "steam");
  });

  it("retains Skyrim's exact name lookup instead of matching Special Edition", async () => {
    const loaded = loadGame("skyrim");
    expect(await loaded.registered[0].queryPath()).toBe("/disposable/game");
    expect(loaded.findByName).toHaveBeenCalledWith("The Elder Scrolls V: Skyrim", "steam");
  });

  it("retains the Skyrim VR app ID list and Fallout 4 VR name lookup", async () => {
    const skyrim = loadGame("skyrimvr");
    expect(await skyrim.registered[0].queryPath()).toBe("/disposable/game");
    expect(skyrim.findByAppId).toHaveBeenCalledWith(["611670"]);
    const fallout = loadGame("fallout4vr");
    expect(await fallout.registered[0].queryPath()).toBe("/disposable/game");
    expect(fallout.findByName).toHaveBeenCalledWith("Fallout 4 VR", "steam");
  });

  it("uses Mount and Blade's declared Steam IDs for names containing display tabs", async () => {
    const loaded = loadGame("mount-and-blade");
    for (const game of loaded.registered) expect(await game.queryPath()).toBe("/disposable/game");
    expect(loaded.findByAppId.mock.calls).toEqual([
      ["22100", "steam"],
      ["48700", "steam"],
      ["48720", "steam"],
    ]);
  });

  it.each(["worldoftanks", "neverwinter-nights", "neverwinter-nights2", "sims4"])(
    "keeps %s available for manual discovery without attempting host registry lookup",
    (slug) => {
      expect(loadGame(slug).registered[0].queryPath).toBeUndefined();
    },
  );

  it.each(["oni", "gardenpaws", "pathfinderkingmaker", "dawnofman"])(
    "finds the installed Unity Mod Manager DLL for %s in its actual mod-type target",
    async (slug) => {
      temporary = await mkdtemp(path.join(os.tmpdir(), "nyastra-umm-check-"));
      await mkdir(path.join(temporary, "UnityModManager"));
      await writeFile(path.join(temporary, "UnityModManager", "UnityModManager.dll"), "test dll");
      const loaded = loadGame(slug, temporary);
      await loaded.registered[0].setup({ path: temporary });
      expect(loaded.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["oni", "gardenpaws", "pathfinderkingmaker", "dawnofman"])(
    "asks for Unity Mod Manager when its DLL is missing for %s and respects the chosen action",
    async (slug) => {
      temporary = await mkdtemp(path.join(os.tmpdir(), "nyastra-umm-check-"));
      const loaded = loadGame(slug, temporary);
      const setup = Promise.resolve(loaded.registered[0].setup({ path: temporary }));
      const result =
        slug === "dawnofman"
          ? expect(setup).resolves.toBeUndefined()
          : expect(setup).rejects.toBeInstanceOf(UserCanceled);
      await vi.waitFor(() => expect(loaded.dispatch).toHaveBeenCalled());
      const action = loaded.dispatch.mock.calls[0][0] as { args: unknown[] };
      const choices = action.args.at(-1) as { label: string; action: () => void }[];
      choices
        .find((choice) => choice.label === (slug === "dawnofman" ? "Continue" : "Cancel"))
        .action();
      await result;
    },
  );
});
