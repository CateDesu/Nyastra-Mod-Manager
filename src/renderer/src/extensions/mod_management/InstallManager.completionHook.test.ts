import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import SevenZip from "node-7z";
import { expect, vi } from "vitest";

import { makeDownload, makeGameStored } from "../../test-utils/builders";
import { test } from "../../test-utils/installManagerTest";
import { UserCanceled } from "../../util/CustomErrors";
for (const scenario of [
  "success",
  "listener throws",
  "listener cancels",
  "callback throws",
] as const)
  test(`completion outcome agrees with installed bytes: ${scenario}`, async ({
    makeInstallManager,
  }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-install-hook-"));
    const archive = path.join(root, "archive.zip"),
      payload = path.join(root, "payload.txt"),
      staging = path.join(root, "staging");
    fs.writeFileSync(payload, "synthetic installed bytes");
    await new SevenZip().add(archive, [payload]);
    const h = makeInstallManager({
      knownGames: [makeGameStored()],
      downloads: {
        archive: makeDownload({
          id: "archive",
          game: ["skyrimse"],
          state: "finished",
          localPath: "archive.zip",
        }),
      },
    });
    h.setState((s) => {
      s.settings.mods.installPath.skyrimse = staging;
    });
    h.manager["mGetInstallPath"] = () => staging;
    h.api.lookupModMeta = () => Bluebird.resolve([]);
    h.manager.addInstaller(
      "synthetic-copy",
      0,
      async () => ({ supported: true, requiredFiles: [] }),
      async () => ({
        instructions: [{ type: "copy", source: "payload.txt", destination: "payload.txt" }],
      }),
    );
    let current = true;
    const callback = vi.fn<(error: Error, id: string) => void>(() => {
      if (scenario === "callback throws") throw new Error("synthetic consumer failure");
    });
    let installedPath = "";
    const listener = (_game: string, _archive: string, id: string) => {
      installedPath = path.join(staging, id, "payload.txt");
      expect(fs.readFileSync(installedPath, "utf8")).toBe("synthetic installed bytes");
      expect(h.getState().persistent.mods.skyrimse[id]?.state).toBe("installed");
      if (scenario === "listener throws") throw new Error("synthetic extension completion failure");
      if (scenario === "listener cancels") current = false;
    };
    h.api.events.on("did-install-mod", listener);
    try {
      h.manager.install(
        "archive",
        archive,
        ["skyrimse"],
        h.api,
        { profileId: h.getState().settings.profiles.activeProfileId },
        false,
        false,
        callback,
        "skyrimse",
        undefined,
        false,
        undefined,
        false,
        undefined,
        undefined,
        () => current,
      );
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1), { timeout: 10000 });
      if (scenario === "listener throws")
        expect(callback.mock.calls[0][0]).toMatchObject({
          message: "synthetic extension completion failure",
        });
      else if (scenario === "listener cancels")
        expect(callback.mock.calls[0][0]).toBeInstanceOf(UserCanceled);
      else expect(callback.mock.calls[0][0]).toBeNull();
      const retained = scenario === "success" || scenario === "callback throws";
      expect(installedPath).not.toBe("");
      expect(fs.existsSync(installedPath)).toBe(retained);
      const id = callback.mock.calls[0][1];
      expect(h.getState().persistent.mods.skyrimse[id]?.state).toBe(
        retained ? "installed" : undefined,
      );
      expect(h.manager.getActiveInstallations()).toEqual([]);
      await Promise.all(h.manager["mRunningInstalls"].values());
      expect(callback).toHaveBeenCalledTimes(1);
      if (!retained) {
        h.api.events.removeListener("did-install-mod", listener);
        const retry = vi.fn();
        h.manager.install(
          "archive",
          archive,
          ["skyrimse"],
          h.api,
          {},
          false,
          false,
          retry,
          "skyrimse",
        );
        await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
        expect(retry.mock.calls[0][0]).toBeNull();
        expect(
          fs.readFileSync(path.join(staging, retry.mock.calls[0][1], "payload.txt"), "utf8"),
        ).toBe("synthetic installed bytes");
        expect(h.getState().persistent.mods.skyrimse[retry.mock.calls[0][1]]?.state).toBe(
          "installed",
        );
        expect(callback).toHaveBeenCalledTimes(1);
      }
    } finally {
      await Promise.all(h.manager["mRunningInstalls"].values());
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
