import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import { afterEach, expect, test, vi } from "vitest";

import {
  makeApiHarness,
  makeGameStored,
  makeMod,
  makeProfile,
  makeProfileSwitchHarness,
  registerHarnessGame,
  resetHarnessRegistries,
} from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import { ProcessCanceled } from "../../util/CustomErrors";
import * as atomic from "../../util/fsAtomic";
import { getGame } from "../gamemode_management/util/getGame";
import hardlinkInit from "../hardlink_activator";
import initProfiles from "../profile_management";
import { setNextProfile } from "../profile_management/actions/settings";
import initMods from "./index";
import { BACKUP_TAG } from "./LinkingDeployment";
import { deploymentReducer } from "./reducers/deployment";
import { sessionReducer } from "./reducers/session";
import type { IMod } from "./types/IMod";
import { loadActivation, saveActivation, withActivationLock } from "./util/activationStore";
import BlacklistSet from "./util/BlacklistSet";
import { getAllActivators, registerDeploymentMethod } from "./util/deploymentMethods";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  resetHarnessRegistries();
});

async function setup(mods: IMod[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nyastra-lifecycle-"));
  const staging = path.join(root, "staging");
  const destination = path.join(root, "Data");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(staging);
  await fs.mkdir(destination);
  registerHarnessGame("skyrimse");
  const profile = makeProfile({
    id: "profile",
    modState: Object.fromEntries(mods.map((mod) => [mod.id, { enabled: true, enabledTime: 1 }])),
  });
  const h = makeApiHarness(
    { knownGames: [makeGameStored()], profiles: { profile }, activeProfileId: profile.id },
    [
      { path: ["session", "mods"], reducer: sessionReducer },
      { path: ["persistent", "deployment"], reducer: deploymentReducer },
    ],
  );
  h.setState((state) => {
    state.app = { ...state.app, instanceId: "fixture" };
    state.persistent.mods.skyrimse = Object.fromEntries(mods.map((mod) => [mod.id, mod]));
    state.settings.mods.installPath.skyrimse = staging;
    state.settings.mods.activator.skyrimse = "hardlink_activator";
    state.settings.gameMode.discovered.skyrimse = { path: root };
    state.settings.window = { ...state.settings.window, useModernLayout: true };
    state.settings.profiles.lastActiveProfile.skyrimse = profile.id;
    state.settings.automation = {
      ...state.settings.automation,
      deploy: false,
      install: false,
      enable: false,
    };
    state.session.base = {
      ...state.session.base,
      commandLine: {},
      activity: {},
      toolsRunning: {},
      progress: {},
    };
  });
  const game = getGame("skyrimse");
  Object.assign(game, { queryModPath: () => destination, mergeMods: true });
  const activators = [...getAllActivators()];
  cleanups.push(async () => {
    getAllActivators().splice(0, getAllActivators().length, ...activators);
  });
  hardlinkInit({ api: h.api, registerDeploymentMethod } as IExtensionContext);
  const method = getAllActivators().find((item) => item.id === "hardlink_activator");
  const callbacks: Array<() => void> = [];
  const context = new Proxy<Partial<IExtensionContext>>(
    { api: h.api, once: (callback) => callbacks.push(callback) },
    { get: (target, key) => (key in target ? Reflect.get(target, key) : () => undefined) },
  );
  h.api.emitAndAwait = h.emitAndAwait as typeof h.api.emitAndAwait;
  h.api.lookupModMeta = vi.fn(() => Bluebird.resolve([]));
  initMods(context as IExtensionContext);
  callbacks.forEach((callback) => callback());
  const seed = async (source: string, content: string) => {
    await fs.mkdir(path.join(staging, source), { recursive: true });
    await fs.writeFile(path.join(staging, source, "config.ini"), content);
  };
  const deploySource = async (source: string) => {
    await method.prepare(destination, true, [], (input) => input.toLowerCase());
    await method.activate(
      path.join(staging, source),
      source,
      "",
      new BlacklistSet([], game, (s) => s),
    );
    const files = await method.finalize("skyrimse", destination, staging);
    await saveActivation("skyrimse", "", "fixture", destination, staging, files, method.id);
  };
  return {
    ...h,
    game,
    method,
    staging,
    destination,
    seed,
    deploySource,
    single: (modId: string) => h.emitAndAwait("deploy-single-mod", "skyrimse", modId),
    full: (failOnError = true) =>
      new Promise<Error | null>((resolve) =>
        h.api.events.emit("deploy-mods", resolve, profile.id, undefined, { failOnError }),
      ),
    manifest: () => loadActivation(h.api, "skyrimse", "", destination, staging, method),
    content: () => fs.readFile(path.join(destination, "config.ini"), "utf8"),
  };
}

test("single redeployment keeps the winner of a before rule even when the mod is disabled", async () => {
  const earlier = makeMod({
    id: "earlier",
    installationPath: "earlier",
    rules: [{ type: "before", reference: { id: "later" } }],
  });
  const later = makeMod({ id: "later", installationPath: "later" });
  const h = await setup([earlier, later]);
  await h.seed("earlier", "earlier");
  await h.seed("later", "later");
  await h.deploySource("later");
  h.setState((state) => {
    state.persistent.profiles.profile.modState.earlier.enabled = false;
  });

  await h.single("earlier");

  expect(await h.content()).toBe("later");
  expect((await h.manifest())[0].source).toBe("later");
});

test("single redeployment respects absolute file overrides", async () => {
  const h = await setup([
    makeMod({ id: "earlier", installationPath: "earlier" }),
    makeMod({ id: "later", installationPath: "later" }),
  ]);
  await h.seed("earlier", "earlier");
  await h.seed("later", "later");
  await h.deploySource("earlier");
  h.setState((state) => {
    state.persistent.mods.skyrimse.later.fileOverrides = [path.join(h.destination, "config.ini")];
  });

  await h.single("later");

  expect(await h.content()).toBe("earlier");
});

test("single redeployment preserves merged output", async () => {
  const h = await setup([makeMod({ id: "mod", installationPath: "mod" })]);
  await h.seed("mod", "unmerged");
  await h.seed("__merged", "merged");
  await h.deploySource("__merged");

  await h.single("mod");

  expect(await h.content()).toBe("merged");
});

for (const failOnError of [true, false]) {
  test(`partial deployment preserves files and reports failure with failOnError=${failOnError}`, async () => {
    const h = await setup([makeMod({ id: "mod", installationPath: "mod" })]);
    await h.seed("mod", "modded");
    const target = path.join(h.destination, "config.ini");
    await fs.writeFile(target, "external");
    await fs.writeFile(target + BACKUP_TAG, "original");
    const didDeploy = vi.fn();
    h.api.events.on("did-deploy", didDeploy);

    const error = await h.full(failOnError);

    expect(await h.content()).toBe("external");
    expect(await fs.readFile(target + BACKUP_TAG, "utf8")).toBe("original");
    expect(await h.manifest()).toEqual([]);
    expect(h.getState().persistent.deployment.needToDeploy.skyrimse).toBe(true);
    expect(h.getState().session.mods.deploymentFailures.skyrimse).toHaveLength(1);
    if (failOnError) {
      expect(error).toBeInstanceOf(Error);
      expect(didDeploy).not.toHaveBeenCalled();
    } else {
      expect(error).toBeNull();
    }
  });
}

test("strict deployment reports a running game instead of claiming success", async () => {
  const h = await setup([makeMod({ id: "mod", installationPath: "mod" })]);
  await h.seed("mod", "modded");
  h.setState((state) => {
    state.session.base.toolsRunning = { game: { started: Date.now(), exclusive: false, pid: 1 } };
  });

  expect(await h.full()).toBeInstanceOf(Error);
  expect(h.getState().persistent.deployment.needToDeploy.skyrimse).toBe(true);
});

test("a single deployment failure rejects its caller and remains pending", async () => {
  const h = await setup([makeMod({ id: "mod", installationPath: "mod" })]);
  await h.seed("mod", "modded");
  const target = path.join(h.destination, "config.ini");
  await fs.writeFile(target, "external");
  await fs.writeFile(target + BACKUP_TAG, "original");

  await expect(h.single("mod")).rejects.toBeInstanceOf(Error);
  expect(await h.content()).toBe("external");
  expect(h.getState().persistent.deployment.needToDeploy.skyrimse).toBe(true);
});

test("an override added to an already deployed mod removes its previous file", async () => {
  const h = await setup([makeMod({ id: "mod", installationPath: "mod" })]);
  await h.seed("mod", "modded");
  const target = path.join(h.destination, "config.ini");
  await fs.writeFile(target, "original");
  await h.deploySource("mod");
  h.setState((state) => {
    state.persistent.mods.skyrimse.mod.fileOverrides = [target];
  });

  await h.single("mod");

  expect(await h.content()).toBe("original");
  expect(await h.manifest()).toEqual([]);
});

for (const single of [true, false]) {
  test(`${single ? "single" : "full"} deployment applies overrides inside the mod output subdirectory`, async () => {
    const h = await setup([makeMod({ id: "mod", installationPath: "mod" })]);
    await h.seed("mod", "modded");
    h.game.mergeMods = () => "nested";
    const target = path.join(h.destination, "nested", "config.ini");
    await fs.mkdir(path.dirname(target));
    await fs.writeFile(target, "original");
    h.setState((state) => {
      state.persistent.mods.skyrimse.mod.fileOverrides = [target];
    });

    if (single) await h.single("mod");
    else expect(await h.full()).toBeNull();

    expect(await fs.readFile(target, "utf8")).toBe("original");
    expect(await h.manifest()).toEqual([]);
  });
}

test("queued single deployment uses the overrides current when it starts", async () => {
  const h = await setup([makeMod({ id: "mod", installationPath: "mod" })]);
  await h.seed("mod", "modded");
  const target = path.join(h.destination, "config.ini");
  await fs.writeFile(target, "original");
  let release: () => void;
  let entered: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withActivationLock(async () => {
    entered();
    await gate;
  });
  await started;
  const queued = h.single("mod");
  h.setState((state) => {
    state.persistent.mods.skyrimse.mod.fileOverrides = [target];
  });
  release();
  await holder;
  await queued;

  expect(await h.content()).toBe("original");
});

test("ignoring a failed manifest write does not complete strict deployment", async () => {
  const h = await setup([makeMod({ id: "mod", installationPath: "mod" })]);
  await h.seed("mod", "modded");
  const write = atomic.writeFileAtomic;
  vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, ...args) =>
    file === path.join(h.destination, "vortex.deployment.json")
      ? Bluebird.reject(Object.assign(new Error("fixture disk full"), { code: "ENOSPC" }))
      : write(file, ...args),
  );
  h.setNextDialog({ action: "Ignore", input: {} });

  expect(await h.full()).toBeInstanceOf(Error);
  expect(h.dialogCalls).toContainEqual({ type: "error", title: "Saving manifest failed" });
  expect(h.getState().persistent.deployment.needToDeploy.skyrimse).toBe(true);
});

test("an empty manifest recovers the deployed file ownership from its backup", async () => {
  const h = await setup([makeMod({ id: "mod", installationPath: "mod" })]);
  await h.seed("mod", "modded");
  await h.deploySource("mod");
  await fs.writeFile(path.join(h.destination, "vortex.deployment.json"), "");
  h.setNextDialog({ action: "Restore from backup", input: {} });

  expect(await h.manifest()).toEqual([
    expect.objectContaining({ source: "mod", relPath: "config.ini" }),
  ]);
  expect(h.dialogCalls).toContainEqual({ type: "question", title: "Manifest damaged" });
});

test("a partial file deployment prevents profile switch completion and preserves snapshots", async () => {
  const h = await setup([makeMod({ id: "mod", installationPath: "mod" })]);
  await h.seed("mod", "modded");
  const target = path.join(h.destination, "config.ini");
  await fs.writeFile(target, "external");
  await fs.writeFile(target + BACKUP_TAG, "original");
  const profiles = await makeProfileSwitchHarness(initProfiles, {
    profiles: [makeProfile({ id: "profile" }), makeProfile({ id: "next" })],
    activeProfileId: "profile",
    lastActive: { skyrimse: "profile" },
    needToDeploy: { skyrimse: true },
    gameSettings: { skyrimse: "outgoing settings" },
    savedSettings: { next: "incoming settings" },
  });
  cleanups.push(profiles.cleanup);
  profiles.api.events.removeAllListeners("deploy-mods");
  const deploy = vi.fn((callback, _profileId, _progress, options) => {
    void h.full(options.failOnError).then(callback);
  });
  profiles.api.events.on("deploy-mods", deploy);

  profiles.api.store.dispatch(setNextProfile("next"));

  await vi.waitFor(() =>
    expect(profiles.getState().settings.profiles.nextProfileId).toBeUndefined(),
  );
  expect(deploy).toHaveBeenCalledTimes(1);
  expect(profiles.getState().settings.profiles.activeProfileId).toBeUndefined();
  expect(await profiles.savedSettings("profile")).toBe("outgoing settings");
  expect(await profiles.savedSettings("next")).toBe("incoming settings");
});

test("a finishing deployment cannot clear a later single deployment failure", async () => {
  const h = await setup([
    makeMod({ id: "first", installationPath: "first" }),
    makeMod({ id: "second", installationPath: "second" }),
  ]);
  await h.seed("first", "first");
  await h.seed("second", "second");
  await fs.writeFile(path.join(h.staging, "second", "extra.ini"), "second extra");
  await fs.writeFile(path.join(h.destination, "extra.ini"), "external extra");
  await fs.writeFile(path.join(h.destination, "extra.ini") + BACKUP_TAG, "original extra");
  h.setState((state) => {
    state.persistent.profiles.profile.modState.second.enabled = false;
  });
  h.api.events.on("did-deploy", async () => {
    await expect(h.single("second")).rejects.toBeInstanceOf(Error);
  });

  expect(await h.full()).toBeNull();

  expect(h.getState().persistent.deployment.needToDeploy.skyrimse).toBe(true);
  expect(await fs.readFile(path.join(h.destination, "extra.ini"), "utf8")).toBe("external extra");
});

test.each(["missing mod", "missing discovery", "missing method", "missing destination"])(
  "single deployment reports %s instead of completing successfully",
  async (reason) => {
    const h = await setup([makeMod({ id: "mod", installationPath: "mod" })]);
    await h.seed("mod", "modded");
    if (reason === "missing mod") {
      h.setState((state) => {
        delete state.persistent.mods.skyrimse.mod;
      });
    } else if (reason === "missing discovery") {
      h.setState((state) => {
        delete state.settings.gameMode.discovered.skyrimse;
      });
    } else if (reason === "missing method") {
      getAllActivators().splice(0);
    } else {
      h.setState((state) => {
        state.persistent.mods.skyrimse.mod.type = "missing-type";
      });
    }
    await expect(h.single("mod")).rejects.toBeInstanceOf(Error);
    expect(h.getState().persistent.deployment.needToDeploy.skyrimse).toBe(true);
    await expect(h.content()).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each(["single", "full"])(
  "%s deployment rejects an empty installation path without deploying other mods",
  async (mode) => {
    const h = await setup([makeMod({ id: "mod", installationPath: "" })]);
    await h.seed("other-mod", "unrequested");
    const result =
      mode === "single"
        ? h.single("mod")
        : h.full().then((err) => {
            if (err) throw err;
          });
    const failure = await result.then(
      () => undefined,
      (err: unknown) => err,
    );
    const unexpected = await fs
      .readFile(path.join(h.destination, "other-mod", "config.ini"), "utf8")
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
        return undefined;
      });
    expect({ failed: failure instanceof Error, unexpected }).toEqual({
      failed: true,
      unexpected: undefined,
    });
    expect(h.getState().persistent.deployment.needToDeploy.skyrimse).toBe(true);
  },
);

for (const reason of ["running tool", "canceled purge"] as const) {
  test(`strict purge reports a ${reason} before an ownership transfer`, async () => {
    const h = await setup([makeMod({ id: "mod", installationPath: "mod" })]);
    await h.seed("mod", "modded");
    await fs.writeFile(path.join(h.destination, "config.ini"), "original");
    await h.deploySource("mod");
    if (reason === "running tool") {
      h.setState((state) => {
        state.session.base.toolsRunning = { game: { started: 1, exclusive: false, pid: 1 } };
      });
    } else {
      h.api.events.on("will-purge", () => {
        throw new ProcessCanceled("Profile no longer exists.");
      });
    }
    const didPurge = vi.fn();
    h.api.events.on("did-purge", didPurge);
    const failure = await new Promise<Error | null>((resolve) =>
      h.api.events.emit("purge-mods", false, resolve, { failOnError: true }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(didPurge).not.toHaveBeenCalled();
    expect(await h.content()).toBe("modded");
    expect(await fs.readFile(path.join(h.destination, "config.ini") + BACKUP_TAG, "utf8")).toBe(
      "original",
    );
    expect((await h.manifest()).map((file) => file.source)).toEqual(["mod"]);
  });
}
