import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import Bluebird from "bluebird";
import { afterEach, describe, expect, vi } from "vitest";

import { makeProfile, makeProfileSwitchHarness } from "../../test-utils/builders";
import { test } from "../../test-utils/profileSwitchTest";
import { UserCanceled } from "../../util/CustomErrors";
import * as atomic from "../../util/fsAtomic";
import { setNextProfile } from "./actions/settings";
import init from "./index";
import type { IProfile } from "./types/IProfile";
import { profilePath } from "./util/manage";

afterEach(() => vi.restoreAllMocks());

const profiles = [
  makeProfile({ id: "skyrim1", gameId: "skyrimse" }),
  makeProfile({ id: "skyrim2", gameId: "skyrimse" }),
  makeProfile({ id: "stardew1", gameId: "stardewvalley" }),
];
const lastActive = { skyrimse: "skyrim1", stardewvalley: "stardew1" };
const skyrimPending = { profiles, lastActive, needToDeploy: { skyrimse: true } };

describe("profile switch", () => {
  test("keeps a corrupt startup profile cleared after cancellation", async () => {
    const profile = makeProfile({ id: "corrupt-startup" });
    const h = await makeProfileSwitchHarness(
      (context) => {
        const checks = new Map<string, Parameters<typeof context.registerActionCheck>[1]>();
        context.registerActionCheck = (type, check) => {
          checks.set(type, check);
        };
        const dispatch = context.api.store.dispatch;
        context.api.store.dispatch = (action) => {
          const check = checks.get(action.type);
          if (check?.(context.api.getState(), action) !== undefined) return action;
          return dispatch(action);
        };
        const initialized = init(context);
        const state = structuredClone(context.api.getState());
        delete (state.persistent.profiles[profile.id] as Partial<IProfile>).gameId;
        context.api.store.dispatch({ type: "__harness_replace_state", payload: state });
        return initialized;
      },
      {
        profiles: [profile],
        activeProfileId: profile.id,
        lastActive: { skyrimse: profile.id },
        gameSettings: { skyrimse: "unsaved live settings" },
        waitForStartup: false,
      },
    );
    try {
      await vi.waitFor(() =>
        expect(h.getState().settings.profiles.activeProfileId).toBeUndefined(),
      );
      expect(h.getState().settings.profiles.nextProfileId).toBeUndefined();
      expect(await h.gameSettings("skyrimse")).toBe("unsaved live settings");
    } finally {
      await h.cleanup();
    }
  });

  test("startup cancellation keeps the live profile available for a successful retry", async ({
    makeProfileSwitch,
  }) => {
    const copy = atomic.copyFileAtomic;
    const canceled = vi
      .spyOn(atomic, "copyFileAtomic")
      .mockImplementation((source, destination) =>
        existsSync(source) ? Bluebird.reject(new UserCanceled()) : copy(source, destination),
      );
    const h = await makeProfileSwitch({
      profiles,
      lastActive,
      activeProfileId: "skyrim1",
      gameSettings: { skyrimse: "unsaved startup settings" },
      waitForStartup: false,
    });
    await vi.waitFor(() =>
      expect(h.dispatched).toContainEqual(
        expect.objectContaining({
          type: setNextProfile.getType(),
          payload: { profileId: "skyrim1" },
        }),
      ),
    );
    expect(h.getState().settings.profiles.activeProfileId).toBe("skyrim1");
    expect(h.getState().settings.profiles.nextProfileId).toBe("skyrim1");
    expect(await h.gameSettings("skyrimse")).toBe("unsaved startup settings");
    canceled.mockRestore();
    await h.switchTo(undefined);
    expect(await h.savedSettings("skyrim1")).toBe("unsaved startup settings");
  });

  test("retains the live profile after an unwritable startup snapshot and saves it on retry", async ({
    makeProfileSwitch,
  }) => {
    const startupProfiles = [makeProfile({ id: "startup-a" }), makeProfile({ id: "startup-b" })];
    const snapshot = profilePath(startupProfiles[0]);
    await mkdir(snapshot, { recursive: true });
    await writeFile(path.join(snapshot, "settings.ini"), "old A snapshot");
    await chmod(snapshot, 0o500);
    try {
      await expect(
        writeFile(path.join(snapshot, "permission-probe"), "probe"),
      ).rejects.toMatchObject({ code: "EACCES" });
      const h = await makeProfileSwitch({
        profiles: startupProfiles,
        lastActive: { skyrimse: "startup-a" },
        activeProfileId: "startup-a",
        gameSettings: { skyrimse: "unsaved A edits" },
        savedSettings: { "startup-b": "B settings" },
        waitForStartup: false,
      });
      await vi.waitFor(() =>
        expect(h.dispatched).toContainEqual(
          expect.objectContaining({
            type: setNextProfile.getType(),
            payload: { profileId: "startup-a" },
          }),
        ),
      );
      expect(h.getState().settings.profiles.activeProfileId).toBe("startup-a");
      expect(h.getState().settings.profiles.nextProfileId).toBe("startup-a");
      expect(await h.gameSettings("skyrimse")).toBe("unsaved A edits");
      expect(await h.savedSettings("startup-a")).toBe("old A snapshot");
      await chmod(snapshot, 0o700);
      h.api.events.removeAllListeners("deploy-mods");
      h.api.events.on("deploy-mods", (cb: (err: Error | null) => void) => cb(null));
      await h.switchTo("startup-b");
      expect(await h.savedSettings("startup-a")).toBe("unsaved A edits");
      expect(await h.gameSettings("skyrimse")).toBe("B settings");
    } finally {
      await chmod(snapshot, 0o700);
    }
  });

  test("does not confirm a profile whose settings could not be restored", async ({
    makeProfileSwitch,
  }) => {
    const h = await makeProfileSwitch({
      profiles,
      lastActive,
      activeProfileId: "skyrim1",
      gameSettings: { skyrimse: "A settings" },
      savedSettings: { skyrim2: "B settings" },
    });
    h.api.events.removeAllListeners("deploy-mods");
    h.api.events.on("deploy-mods", (cb: (err: Error | null) => void) => cb(null));
    const copy = atomic.copyFileAtomic;
    const failed = vi
      .spyOn(atomic, "copyFileAtomic")
      .mockImplementation((source, destination) =>
        source === path.join(profilePath(profiles[1]), "settings.ini")
          ? Bluebird.reject(Object.assign(new Error("restore failed"), { code: "ENOSPC" }))
          : copy(source, destination),
      );
    h.api.store.dispatch(setNextProfile("skyrim2"));
    await vi.waitFor(() => expect(h.getState().settings.profiles.nextProfileId).toBeUndefined());
    expect(h.getState().settings.profiles.activeProfileId).toBeUndefined();
    expect(await h.gameSettings("skyrimse")).toBe("A settings");
    expect(await h.savedSettings("skyrim1")).toBe("A settings");
    failed.mockRestore();
    await h.switchTo("skyrim2");
    expect(await h.gameSettings("skyrimse")).toBe("B settings");
  });

  test("keeps unsaved settings and the active profile when its snapshot is unwritable", async ({
    makeProfileSwitch,
  }) => {
    const h = await makeProfileSwitch({
      profiles,
      lastActive,
      activeProfileId: "skyrim1",
      gameSettings: { skyrimse: "A settings" },
      savedSettings: { skyrim2: "B settings" },
    });
    h.api.events.removeAllListeners("deploy-mods");
    h.api.events.on("deploy-mods", (cb: (err: Error | null) => void) => cb(null));
    h.api.events.on("profile-will-change", (_id: string, enqueue) => {
      enqueue(() => Bluebird.resolve());
    });
    await h.switchTo("skyrim2");
    await h.switchTo("skyrim1");
    await h.setGameSettings("skyrimse", "unsaved A settings");
    const snapshot = profilePath(profiles[0]);
    await chmod(snapshot, 0o500);
    try {
      await expect(
        writeFile(path.join(snapshot, "permission-probe"), "probe"),
      ).rejects.toMatchObject({
        code: "EACCES",
      });
      h.api.store.dispatch(setNextProfile("skyrim2"));
      await vi.waitFor(() => expect(h.getState().settings.profiles.nextProfileId).toBe("skyrim1"));
      expect(h.getState().settings.profiles.activeProfileId).toBe("skyrim1");
      expect(await h.gameSettings("skyrimse")).toBe("unsaved A settings");
      expect(await h.savedSettings("skyrim1")).toBe("A settings");
    } finally {
      await chmod(snapshot, 0o700);
    }
    await h.switchTo("skyrim2");
    expect(await h.savedSettings("skyrim1")).toBe("unsaved A settings");
    expect(await h.gameSettings("skyrimse")).toBe("B settings");
  });

  test("cancelling a snapshot aborts deactivation and permits a retry", async ({
    makeProfileSwitch,
  }) => {
    const h = await makeProfileSwitch({
      profiles,
      lastActive,
      activeProfileId: "skyrim1",
      gameSettings: { skyrimse: "A settings" },
    });
    await h.setGameSettings("skyrimse", "unsaved A settings");
    const copy = vi
      .spyOn(atomic, "copyFileAtomic")
      .mockImplementationOnce(() => Bluebird.reject(new UserCanceled()));
    h.api.store.dispatch(setNextProfile(undefined));
    await vi.waitFor(() => expect(h.getState().settings.profiles.nextProfileId).toBe("skyrim1"));
    expect(h.getState().settings.profiles.activeProfileId).toBe("skyrim1");
    expect(await h.gameSettings("skyrimse")).toBe("unsaved A settings");
    copy.mockRestore();
    await h.switchTo(undefined);
    expect(await h.savedSettings("skyrim1")).toBe("unsaved A settings");
  });

  test("finishes saving the outgoing profile before announcing deactivation", async ({
    makeProfileSwitch,
  }) => {
    const h = await makeProfileSwitch({
      profiles,
      lastActive,
      activeProfileId: "skyrim1",
      gameSettings: { skyrimse: "outgoing settings" },
    });
    const order: string[] = [];
    const entered = Bluebird.defer<void>();
    const gate = Bluebird.defer<void>();
    const copied = Bluebird.defer<void>();
    const copy = atomic.copyFileAtomic;
    vi.spyOn(atomic, "copyFileAtomic").mockImplementation((source, destination) => {
      if (
        destination !== path.join(profilePath(profiles[0]), "settings.ini") ||
        !existsSync(source)
      )
        return copy(source, destination);
      order.push("save started");
      entered.resolve();
      return Bluebird.resolve(gate.promise)
        .then(() => copy(source, destination))
        .then(() => {
          order.push("save completed");
        })
        .finally(() => copied.resolve());
    });
    h.api.events.on("profile-did-change", () => order.push("profile changed"));
    const deactivated = h.switchTo(undefined);
    try {
      await entered.promise;
    } finally {
      gate.resolve();
      await copied.promise;
      await deactivated;
    }
    expect(order).toEqual(["save started", "save completed", "profile changed"]);
    expect(await h.savedSettings("skyrim1")).toBe("outgoing settings");
  });

  test("deploys both profiles when switching within the same game", async ({
    makeProfileSwitch,
  }) => {
    const harness = await makeProfileSwitch({ ...skyrimPending, activeProfileId: "skyrim1" });

    await harness.switchTo("skyrim2");

    expect(harness.deployed).toEqual(["skyrim1", "skyrim2"]);
  });

  test("switches to another game's last active profile without deploying", async ({
    makeProfileSwitch,
  }) => {
    const harness = await makeProfileSwitch({ ...skyrimPending, activeProfileId: "skyrim1" });

    await harness.switchTo("stardew1");

    expect(harness.deployed).toEqual([]);
    expect(harness.getState().persistent.deployment.needToDeploy.skyrimse).toBe(true);
    expect(
      harness.loggedMessages().filter((message) => /^(will|did) deploy/.test(message)),
    ).toEqual([]);
  });

  test("returns to a game's last active profile without deploying its pending changes", async ({
    makeProfileSwitch,
  }) => {
    const harness = await makeProfileSwitch({ ...skyrimPending, activeProfileId: "stardew1" });

    await harness.switchTo("skyrim1");

    expect(harness.deployed).toEqual([]);
    expect(harness.getState().persistent.deployment.needToDeploy.skyrimse).toBe(true);
  });

  test("keeps the last active profile's pending changes when switching to another of its profiles", async ({
    makeProfileSwitch,
  }) => {
    const harness = await makeProfileSwitch({
      ...skyrimPending,
      activeProfileId: "stardew1",
      gameSettings: { skyrimse: "undeployed:skyrim1" },
      savedSettings: { skyrim1: "undeployed:skyrim1" },
    });

    await harness.switchTo("skyrim2");

    expect(await harness.savedSettings("skyrim1")).toBe("deployed:skyrim1");
    expect(await harness.gameSettings("skyrimse")).toBe("deployed:skyrim2");
  });

  test("deploys another profile of a game with nothing pending", async ({ makeProfileSwitch }) => {
    const harness = await makeProfileSwitch({
      profiles,
      lastActive,
      activeProfileId: "stardew1",
      gameSettings: { skyrimse: "deployed:skyrim1" },
      savedSettings: { skyrim1: "deployed:skyrim1" },
    });

    await harness.switchTo("skyrim2");

    expect(harness.deployed).toEqual(["skyrim2"]);
    expect(await harness.savedSettings("skyrim1")).toBe("deployed:skyrim1");
  });
});
