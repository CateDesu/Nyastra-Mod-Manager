import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test, vi } from "vitest";

import {
  makeApiHarness,
  makeGameStored,
  makeProfile,
  registerHarnessGame,
  resetHarnessRegistries,
} from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import { getGame } from "../gamemode_management/util/getGame";
import hardlinkInit from "../hardlink_activator";
import initMods from "./index";
import { getAllActivators, registerDeploymentMethod } from "./util/deploymentMethods";

for (const failOnError of [true, false]) {
  test(`deployment reports a setup failure with failOnError=${failOnError}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nyastra-deploy-failure-"));
    registerHarnessGame("skyrimse");
    const profile = makeProfile({ id: "profile" });
    const h = makeApiHarness({
      knownGames: [makeGameStored()],
      profiles: { profile },
      activeProfileId: profile.id,
    });
    h.setState((state) => {
      state.app = { ...state.app, instanceId: "fixture" };
      state.persistent.mods.skyrimse = {};
      state.settings.mods.installPath.skyrimse = path.join(root, "staging");
      state.settings.mods.activator.skyrimse = "hardlink_activator";
      state.settings.gameMode.discovered.skyrimse = { path: root };
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
    Object.assign(getGame("skyrimse"), {
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
      const error = await new Promise<Error | null>((resolve) =>
        h.api.events.emit(
          "deploy-mods",
          resolve,
          h.getState().settings.profiles.activeProfileId,
          undefined,
          { failOnError },
        ),
      );
      expect(error).toBe(failOnError ? failure : null);
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
}
