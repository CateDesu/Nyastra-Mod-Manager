import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import SevenZip from "node-7z";
import { expect, vi } from "vitest";

import { makeGameStored, makeMod } from "../../test-utils/builders";
import { test } from "../../test-utils/installManagerTest";
import type { InstallFunc } from "./types/InstallFunc";

test("preserves a recorded size when the staging folder is missing", async ({
  makeInstallManager,
}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nyastra-mod-size-"));
  const mod = makeMod({ installationPath: "missing", attributes: { modSize: 42 } });
  const h = makeInstallManager({ mods: { skyrimse: { [mod.id]: mod } } });
  h.setState((state) => {
    state.settings.mods.installPath.skyrimse = root;
  });
  try {
    await h.manager["setModSize"](h.api, mod.id, "skyrimse");
    expect(h.getState().persistent.mods.skyrimse[mod.id].attributes.modSize).toBe(42);
    await fs.mkdir(path.join(root, "missing"));
    await h.manager["setModSize"](h.api, mod.id, "skyrimse");
    expect(h.getState().persistent.mods.skyrimse[mod.id].attributes.modSize).toBe(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("does not calculate the staging root for a mod without an install path", async ({
  makeInstallManager,
}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nyastra-mod-size-"));
  await fs.writeFile(path.join(root, "another-mod.txt"), "other mod content");
  const mod = makeMod({ installationPath: "", attributes: { modSize: 42 } });
  const h = makeInstallManager({ mods: { skyrimse: { [mod.id]: mod } } });
  h.setState((state) => {
    state.settings.mods.installPath.skyrimse = root;
  });
  try {
    await h.manager["setModSize"](h.api, mod.id, "skyrimse");
    expect(h.getState().persistent.mods.skyrimse[mod.id].attributes.modSize).toBe(42);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("passes local archive lookup identity to the installer", async ({ makeInstallManager }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nyastra-local-meta-"));
  const archive = path.join(root, "archive.zip");
  const payload = path.join(root, "payload.txt");
  const staging = path.join(root, "staging");
  await fs.writeFile(payload, "synthetic payload");
  await new SevenZip().add(archive, [payload]);
  const h = makeInstallManager({ knownGames: [makeGameStored()] });
  h.setState((state) => {
    state.settings.mods.installPath.skyrimse = staging;
  });
  h.manager["mGetInstallPath"] = () => staging;
  h.api.lookupModMeta = () =>
    Bluebird.resolve([
      {
        key: "lookup",
        value: {
          fileName: "archive.zip",
          gameId: "skyrimse",
          fileSizeBytes: 10,
          fileMD5: "synthetic-md5",
          fileVersion: "1.0",
          source: "nexus",
          sourceURI: "nxm://skyrimspecialedition/mods/518/files/42",
          details: { modId: "518", fileId: "42" },
        },
      },
    ]);
  const installer = vi.fn<InstallFunc>(async () => ({
    instructions: [{ type: "copy" as const, source: "payload.txt", destination: "payload.txt" }],
  }));
  h.manager.addInstaller(
    "synthetic-copy",
    0,
    async () => ({ supported: true, requiredFiles: [] }),
    installer,
  );
  const callback = vi.fn<(error: Error, id: string) => void>();
  try {
    h.manager.install(
      undefined,
      archive,
      ["skyrimse"],
      h.api,
      { profileId: h.getState().settings.profiles.activeProfileId },
      false,
      false,
      callback,
      "skyrimse",
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1), { timeout: 10000 });
    expect(callback.mock.calls[0][0]).toBeNull();
    expect(installer).toHaveBeenCalledTimes(1);
    expect(installer.mock.calls[0][7]?.modReference).toMatchObject({
      repo: { repository: "nexus", modId: "518", fileId: "42" },
      gameId: "skyrimse",
      logicalFileName: "archive.zip",
    });
  } finally {
    await Promise.all(h.manager["mRunningInstalls"].values());
    await fs.rm(root, { recursive: true, force: true });
  }
});
