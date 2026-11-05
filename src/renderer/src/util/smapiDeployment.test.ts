import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test, vi } from "vitest";

import { getGame } from "../extensions/gamemode_management/util/getGame";
import hardlinkInit from "../extensions/hardlink_activator";
import initMods from "../extensions/mod_management";
import {
  getAllActivators,
  registerDeploymentMethod,
} from "../extensions/mod_management/util/deploymentMethods";
import {
  makeApiHarness,
  makeGameStored,
  makeProfile,
  registerHarnessGame,
  resetHarnessRegistries,
} from "../test-utils/builders";
import type { IExtensionApi, IExtensionContext } from "../types/IExtensionContext";

vi.mock("@nexusmods/vortex-api", () => ({
  actions: {
    setPrimaryTool: (gameId: string, toolId: string) => ({
      type: "SET_PRIMARY_TOOL",
      payload: { gameId, toolId },
    }),
  },
  selectors: {
    lastActiveProfileForGame: (state: any, gameId: string) =>
      state.settings.profiles.lastActiveProfile[gameId],
    discoveryByGame: () => ({ tools: { smapi: { id: "smapi" } } }),
  },
  util: {
    toPromise: (invoke: (cb: (error: Error | null) => void) => void) =>
      new Promise<void>((resolve, reject) =>
        invoke((error) => (error ? reject(error) : resolve())),
      ),
  },
}));

test("SMAPI stops before discovery and primary-tool selection when deployment fails", async () => {
  const lifecyclePath = path.resolve(
    __dirname,
    "../../../../extensions/games/game-stardewvalley/src/smapi/lifecycle.ts",
  );
  const { deploySMAPI } = (await import(lifecyclePath)) as {
    deploySMAPI: (api: IExtensionApi) => Promise<void>;
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nyastra-deploy-failure-"));
  registerHarnessGame("stardewvalley");
  const profile = makeProfile({ id: "profile", gameId: "stardewvalley" });
  const h = makeApiHarness({
    knownGames: [makeGameStored({ id: "stardewvalley" })],
    profiles: { profile },
    activeProfileId: profile.id,
  });
  h.setState((state) => {
    state.settings.profiles.lastActiveProfile.stardewvalley = "profile";
    state.app = { ...state.app, instanceId: "fixture" };
    state.persistent.mods.stardewvalley = {};
    state.settings.mods.installPath.stardewvalley = path.join(root, "staging");
    state.settings.mods.activator.stardewvalley = "hardlink_activator";
    state.settings.gameMode.discovered.stardewvalley = { path: root };
    state.settings.window = { ...state.settings.window, useModernLayout: true };
    state.settings.automation = {
      ...state.settings.automation,
      deploy: false,
      install: false,
      enable: false,
    };
    state.session.mods = { ...state.session.mods, deploymentFailures: {} };
    state.session.base = {
      ...state.session.base,
      commandLine: {},
      activity: {},
      toolsRunning: {},
      progress: {},
    };
  });
  await fs.mkdir(path.join(root, "staging"));
  await fs.mkdir(path.join(root, "Data"));
  Object.assign(getGame("stardewvalley"), {
    queryModPath: () => path.join(root, "Data"),
    mergeMods: true,
  });
  const activators = [...getAllActivators()];
  const callbacks: Array<() => void> = [];
  const context = new Proxy<Partial<IExtensionContext>>(
    { api: h.api, once: (callback) => callbacks.push(callback) },
    { get: (target, key) => (key in target ? Reflect.get(target, key) : () => undefined) },
  );
  h.api.emitAndAwait = h.emitAndAwait as typeof h.api.emitAndAwait;
  const failure = new Error("synthetic deployment preparation failure");
  const prepare = vi.fn(() => {
    throw failure;
  });
  h.api.events.on("will-deploy", prepare);
  hardlinkInit({ api: h.api, registerDeploymentMethod } as IExtensionContext);
  initMods(context as IExtensionContext);
  callbacks.forEach((callback) => callback());
  try {
    const discovery = vi.fn((cb: () => void) => cb());
    h.api.events.on("start-quick-discovery", discovery);
    await expect(deploySMAPI(h.api)).rejects.toBe(failure);
    expect(discovery).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.errorNotifications).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Failed to deploy mods" })]),
    );
  } finally {
    getAllActivators().splice(0, getAllActivators().length, ...activators);
    resetHarnessRegistries();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
});
