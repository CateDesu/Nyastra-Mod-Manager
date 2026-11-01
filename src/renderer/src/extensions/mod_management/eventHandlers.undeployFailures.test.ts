import * as nodeFs from "node:fs";
import * as path from "node:path";

import PromiseBB from "bluebird";
import { afterEach, expect, vi } from "vitest";

import { makeApiHarness, makeMod } from "../../test-utils/builders";
import { test } from "../../test-utils/deploymentTest";
import { TemporaryError } from "../../util/CustomErrors";
import * as fs from "../../util/fs";
import * as fsAtomic from "../../util/fsAtomic";
import { getGame } from "../gamemode_management/util/getGame";
import hardlinkInit from "../hardlink_activator";
import moveInit from "../move_activator";
import symlinkInit from "../symlink_activator";
import { onRemoveMods } from "./eventHandlers";
import type InstallManager from "./InstallManager";
import { sessionReducer } from "./reducers/session";
import type { IDeploymentMethod } from "./types/IDeploymentMethod";
import { saveActivation } from "./util/activationStore";

afterEach(() => vi.restoreAllMocks());

for (const kind of ["hardlink", "symlink", "move"] as const) {
  test(`${kind} undeployment failure blocks staging deletion and permits removal retry`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ method: kind, files: { "config.ini": "mod data" } });
    const manifest = await h.deploy();
    const modDir = path.join(h.stagingDir, "SomeMod");
    const target = h.inGame("config.ini");
    const removal = makeApiHarness(
      {
        mods: { skyrimse: { SomeMod: makeMod({ id: "SomeMod", installationPath: "SomeMod" }) } },
        discovered: { skyrimse: { path: h.gameDir } },
        installPath: { skyrimse: h.stagingDir },
      },
      [{ path: ["session", "mods"], reducer: sessionReducer }],
    );
    removal.setState((state) => {
      state.app = { ...state.app, instanceId: "removal-test" };
    });
    getGame("skyrimse").queryModPath = () => h.gameDir;
    let method: IDeploymentMethod;
    ({ hardlink: hardlinkInit, symlink: symlinkInit, move: moveInit })[kind]({
      api: removal.api,
      registerDeploymentMethod: (value) => {
        method = value;
      },
    } as Parameters<typeof hardlinkInit>[0]);
    removal.setState((state) => {
      state.settings.mods.activator.skyrimse = method.id;
    });
    await saveActivation(
      "skyrimse",
      "",
      "removal-test",
      h.gameDir,
      h.stagingDir,
      manifest,
      method.id,
    );
    const manager = { markRecentRemoval: vi.fn() } as unknown as InstallManager;
    const failure = Object.assign(new Error("unlink denied"), { code: "EACCES" });
    let fault: { mockRestore: () => void };
    if (kind === "move") {
      const move = fsAtomic.moveFileNoReplace;
      fault = vi
        .spyOn(fsAtomic, "moveFileNoReplace")
        .mockImplementation((from, to) =>
          from === target ? Promise.reject(failure) : move(from, to),
        );
    } else {
      const operation = kind === "hardlink" ? "unlinkAsync" : "removeAsync";
      const unlink = fs[operation];
      fault = vi
        .spyOn(fs, operation)
        .mockImplementation((file, ...args) =>
          file === target ? PromiseBB.reject(failure) : unlink(file, ...args),
        );
    }
    let finished = 0;
    const didRemove = vi.fn();
    vi.spyOn(removal.api, "emitAndAwait").mockImplementation(async (event, ...args) => {
      if (event === "did-remove-mod") didRemove(...args);
      if (event === "did-remove-mods") finished++;
      return [];
    });
    const callback = vi.fn();

    onRemoveMods(removal.api, [method], manager, "skyrimse", ["SomeMod"], callback);
    await vi.waitFor(() => expect(finished).toBe(1), { timeout: 1000 });

    expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(TemporaryError));
    expect(didRemove).not.toHaveBeenCalled();
    expect(manager.markRecentRemoval).not.toHaveBeenCalled();
    expect(removal.getState().persistent.mods.skyrimse.SomeMod).toBeDefined();
    expect(nodeFs.statSync(modDir).isDirectory()).toBe(true);
    expect(nodeFs.readFileSync(target, "utf8")).toBe("mod data");
    const saved = JSON.parse(nodeFs.readFileSync(h.inGame("vortex.deployment.json"), "utf8"));
    expect(saved.files).toEqual(manifest);

    fault.mockRestore();
    callback.mockClear();
    onRemoveMods(removal.api, [method], manager, "skyrimse", ["SomeMod"], callback);
    await vi.waitFor(() => expect(finished).toBe(2), { timeout: 1000 });
    expect(callback).toHaveBeenCalledExactlyOnceWith(null);
    expect(didRemove).toHaveBeenCalledTimes(1);
    expect(removal.getState().persistent.mods.skyrimse).toEqual({});
    expect(nodeFs.existsSync(modDir)).toBe(false);
    expect(nodeFs.existsSync(target)).toBe(false);
  });
}
