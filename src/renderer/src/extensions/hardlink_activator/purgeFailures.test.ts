import * as nodeFs from "node:fs";
import * as path from "node:path";

import PromiseBB from "bluebird";
import { afterEach, expect, vi } from "vitest";

import { makeProfile } from "../../test-utils/builders";
import { test } from "../../test-utils/deploymentTest";
import { UserCanceled } from "../../util/CustomErrors";
import * as fs from "../../util/fs";
import { getGame } from "../gamemode_management/util/getGame";
import { BACKUP_TAG } from "../mod_management/LinkingDeployment";
import { saveActivation } from "../mod_management/util/activationStore";
import { purgeMods } from "../mod_management/util/deploy";
import * as methods from "../mod_management/util/deploymentMethods";

afterEach(() => vi.restoreAllMocks());

test("a failed hardlink purge retains its manifest and backup until retry succeeds", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({
    files: { "config.ini": "mod config", "other.ini": "other mod" },
    profiles: { p: makeProfile({ id: "p" }) },
    activeProfileId: "p",
    lastActiveProfile: { skyrimse: "p" },
  });
  const target = h.inGame("config.ini");
  nodeFs.writeFileSync(target, "original config");
  const manifest = await h.deploy();
  getGame("skyrimse").queryModPath = () => h.gameDir;
  h.setState((state) => {
    state.app = { ...state.app, instanceId: "purge-test" };
    state.settings.mods.installPath.skyrimse = h.stagingDir;
    state.settings.gameMode.discovered.skyrimse = { path: h.gameDir };
  });
  vi.spyOn(methods, "getActivator").mockReturnValue(h.method);
  vi.spyOn(methods, "getCurrentActivator").mockReturnValue(h.method);
  vi.spyOn(h.api, "emitAndAwait").mockImplementation(async (event, ...args) => {
    await h.emitAndAwait(event, ...args);
    return [];
  });
  const didPurge = vi.fn();
  h.api.events.on("did-purge", didPurge);
  await saveActivation(
    "skyrimse",
    "",
    "purge-test",
    h.gameDir,
    h.stagingDir,
    manifest,
    h.method.id,
  );
  const unlink = fs.unlinkAsync;
  const failure = Object.assign(new Error("unlink denied"), { code: "EACCES" });
  const fault = vi
    .spyOn(fs, "unlinkAsync")
    .mockImplementation((file, ...args) =>
      file === target ? PromiseBB.reject(failure) : unlink(file, ...args),
    );

  await expect(purgeMods(h.api)).rejects.toBe(failure);

  expect(didPurge).not.toHaveBeenCalled();
  expect(h.dialogCalls).toEqual([]);
  expect(nodeFs.readFileSync(target, "utf8")).toBe("mod config");
  expect(nodeFs.readFileSync(target + BACKUP_TAG, "utf8")).toBe("original config");
  expect(nodeFs.existsSync(h.inGame("other.ini"))).toBe(false);
  const saved = JSON.parse(nodeFs.readFileSync(h.inGame("vortex.deployment.json"), "utf8"));
  expect(saved.files).toEqual([expect.objectContaining({ relPath: "config.ini" })]);
  expect(nodeFs.existsSync(path.join(h.stagingDir, "vortex.deployment.msgpack"))).toBe(true);

  fault.mockRestore();
  await purgeMods(h.api);
  expect(didPurge).toHaveBeenCalledExactlyOnceWith("p");
  expect(nodeFs.readFileSync(target, "utf8")).toBe("original config");
  expect(nodeFs.existsSync(target + BACKUP_TAG)).toBe(false);
  expect(nodeFs.existsSync(h.inGame("vortex.deployment.json"))).toBe(false);
  expect(nodeFs.existsSync(path.join(h.stagingDir, "vortex.deployment.msgpack"))).toBe(false);
});

test("hardlink purge waits for started unlinks before reporting failure", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "failed.ini": "failed", "pending.ini": "pending" } });
  await h.deploy();
  const unlink = fs.unlinkAsync;
  const failure = Object.assign(new Error("unlink denied"), { code: "EACCES" });
  let release: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  let settled = false;
  vi.spyOn(fs, "unlinkAsync").mockImplementation((file, ...args) => {
    if (file === h.inGame("failed.ini")) return PromiseBB.reject(failure);
    if (file !== h.inGame("pending.ini")) return unlink(file, ...args);
    started = true;
    return PromiseBB.resolve(gate).then(() => unlink(file, ...args));
  });
  const outcome = h.method.purge(h.stagingDir, h.gameDir, "skyrimse").then(
    () => {
      settled = true;
      return undefined;
    },
    (err: unknown) => {
      settled = true;
      return err;
    },
  );
  try {
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
  } finally {
    release();
  }
  expect(await outcome).toBe(failure);
  expect(nodeFs.existsSync(h.inGame("pending.ini"))).toBe(false);
  expect(nodeFs.readFileSync(h.inGame("failed.ini"), "utf8")).toBe("failed");
});

test("canceling hardlink purge preserves queued links and rejects", async ({ makeDeployment }) => {
  const files = Object.fromEntries(
    Array.from({ length: 60 }, (_, index) => [`${index}.ini`, "mod"]),
  );
  const h = makeDeployment({ files });
  await h.deploy();
  const canceled = new UserCanceled();
  const unlink = vi.spyOn(fs, "unlinkAsync").mockRejectedValue(canceled);

  await expect(h.method.purge(h.stagingDir, h.gameDir, "skyrimse")).rejects.toBe(canceled);

  expect(unlink.mock.calls.length).toBeLessThan(60);
  expect(h.deployedFiles()).toHaveLength(60);
  unlink.mockRestore();
  await h.method.postPurge();
  await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
  expect(h.deployedFiles()).toEqual([]);
});
