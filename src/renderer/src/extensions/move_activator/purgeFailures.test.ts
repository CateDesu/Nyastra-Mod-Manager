import * as nodeFs from "node:fs";
import * as path from "node:path";

import { afterEach, expect, vi } from "vitest";

import { makeProfile } from "../../test-utils/builders";
import { test } from "../../test-utils/deploymentTest";
import { UserCanceled } from "../../util/CustomErrors";
import * as atomic from "../../util/fsAtomic";
import { getGame } from "../gamemode_management/util/getGame";
import { saveActivation, withActivationLock } from "../mod_management/util/activationStore";
import { purgeMods } from "../mod_management/util/deploy";
import * as methods from "../mod_management/util/deploymentMethods";

afterEach(() => vi.restoreAllMocks());

async function bounded<T>(operation: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Move purge drain timed out")), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const scenario of ["success", "failure", "cancellation", "first error"] as const) {
  test(`public move purge drains restores before manifest persistence and lock release on ${scenario}`, async ({
    makeDeployment,
  }) => {
    const files = { "failed.ini": "failed data", "pending.ini": "pending data" };
    if (scenario === "first error") files["later.ini"] = "later data";
    const h = makeDeployment({
      method: "move",
      files,
      profiles: { p: makeProfile({ id: "p" }) },
      activeProfileId: "p",
      lastActiveProfile: { skyrimse: "p" },
    });
    const manifest = await h.deploy();
    getGame("skyrimse").queryModPath = () => h.gameDir;
    h.setState((state) => {
      state.app = { ...state.app, instanceId: "move-purge-test" };
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
    const postPurge = vi.spyOn(h.method, "postPurge");
    await saveActivation(
      "skyrimse",
      "",
      "move-purge-test",
      h.gameDir,
      h.stagingDir,
      manifest,
      h.method.id,
    );
    const manifestPath = h.inGame("vortex.deployment.json");
    const storedPaths = () =>
      nodeFs.existsSync(manifestPath)
        ? JSON.parse(nodeFs.readFileSync(manifestPath, "utf8"))
            .files.map((file) => file.relPath)
            .sort()
        : [];
    const failure =
      scenario === "cancellation"
        ? new UserCanceled()
        : Object.assign(new Error("first restore denied"), { code: "EACCES" });
    const laterFailure = Object.assign(new Error("later restore denied"), { code: "EBUSY" });
    const move = atomic.moveFileNoReplace;
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let failed = false;
    let restored = false;
    let settled = false;
    let settledBeforeRestore = false;
    let lockBeforeRestore = false;
    let lockedManifest: string[];
    let pending: Promise<void>;
    let firstFailure: Promise<void>;
    const fault = vi.spyOn(atomic, "moveFileNoReplace").mockImplementation((from, to) => {
      if (from === h.inGame("failed.ini") && scenario !== "success") {
        firstFailure = started.then(() => {
          failed = true;
          throw failure;
        });
        return firstFailure;
      }
      if (from === h.inGame("later.ini") && scenario === "first error") {
        return started.then(async () => {
          await vi.waitFor(() => expect(failed).toBe(true), { timeout: 1000 });
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw laterFailure;
        });
      }
      if (from !== h.inGame("pending.ini")) return move(from, to);
      markStarted();
      pending = gate
        .then(() => move(from, to))
        .then(() => {
          restored = true;
        });
      return pending;
    });
    const outcome = purgeMods(h.api).then(
      () => {
        settled = true;
        settledBeforeRestore = !restored;
        return undefined;
      },
      (err: unknown) => {
        settled = true;
        settledBeforeRestore = !restored;
        return err;
      },
    );
    let contender: PromiseLike<unknown>;
    try {
      await bounded(started);
      if (scenario !== "success")
        await vi.waitFor(() => expect(failed).toBe(true), { timeout: 1000 });
      contender = withActivationLock(async () => {
        lockBeforeRestore = !restored;
        lockedManifest = storedPaths();
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect.soft(settled).toBe(false);
      expect.soft(lockBeforeRestore).toBe(false);
      expect.soft(postPurge).not.toHaveBeenCalled();
      expect.soft(didPurge).not.toHaveBeenCalled();
      expect(nodeFs.readFileSync(h.inGame("pending.ini"), "utf8")).toBe("pending data");
      expect(storedPaths()).toEqual(Object.keys(files).sort());
    } finally {
      release();
      await bounded(Promise.all([pending, outcome, contender]));
      await vi.waitFor(
        () =>
          expect(nodeFs.existsSync(path.join(h.stagingDir, "SomeMod/pending.ini.vortex_lnk"))).toBe(
            false,
          ),
        { timeout: 1000 },
      );
    }
    expect.soft(settledBeforeRestore).toBe(false);
    expect.soft(lockBeforeRestore).toBe(false);
    expect.soft(await outcome).toBe(scenario === "success" ? undefined : failure);
    const remaining =
      scenario === "success"
        ? []
        : scenario === "first error"
          ? ["failed.ini", "later.ini"]
          : ["failed.ini"];
    expect(storedPaths()).toEqual(remaining);
    expect.soft(lockedManifest).toEqual(remaining);
    const source = path.join(h.stagingDir, "SomeMod");
    for (const [file, content] of Object.entries(files)) {
      const deployed = remaining.includes(file);
      expect(nodeFs.existsSync(h.inGame(file))).toBe(deployed);
      expect(nodeFs.existsSync(path.join(source, file + ".vortex_lnk"))).toBe(deployed);
      expect(nodeFs.readFileSync(deployed ? h.inGame(file) : path.join(source, file), "utf8")).toBe(
        content,
      );
    }
    if (scenario !== "success") {
      expect(didPurge).not.toHaveBeenCalled();
      fault.mockRestore();
      await bounded(purgeMods(h.api));
    }
    expect(didPurge).toHaveBeenCalledExactlyOnceWith("p");
    expect(nodeFs.existsSync(manifestPath)).toBe(false);
    expect(nodeFs.existsSync(path.join(h.stagingDir, "vortex.deployment.msgpack"))).toBe(false);
    for (const [file, content] of Object.entries(files)) {
      expect(nodeFs.existsSync(h.inGame(file))).toBe(false);
      expect(nodeFs.existsSync(path.join(source, file + ".vortex_lnk"))).toBe(false);
      expect(nodeFs.readFileSync(path.join(source, file), "utf8")).toBe(content);
    }
  });
}
