import * as nodeFs from "node:fs";
import * as path from "node:path";

import PromiseBB from "bluebird";
import { afterEach, expect, vi } from "vitest";

import { test, type DeploymentMethodName } from "../../test-utils/deploymentTest";
import * as fs from "../../util/fs";
import { addDeploymentFailures } from "./actions/session";
import { BACKUP_TAG } from "./LinkingDeployment";

afterEach(() => vi.restoreAllMocks());

for (const method of ["hardlink", "symlink", "move"] satisfies DeploymentMethodName[]) {
  for (const redeploy of [false, true]) {
    test(`${method} restores the original after a failed ${redeploy ? "redeployment" : "deployment"}`, async ({
      makeDeployment,
    }) => {
      const h = makeDeployment({
        method,
        files: { "config.ini": "modded", "other.ini": "other mod" },
      });
      const target = h.inGame("config.ini");
      const source = path.join(h.stagingDir, "SomeMod", "config.ini");
      nodeFs.writeFileSync(target, "original");
      const previous = redeploy ? await h.deploy() : [];
      const changed = previous.map((file) =>
        file.relPath === "config.ini" ? { ...file, time: file.time - 1 } : file,
      );

      const operation =
        method === "hardlink" ? "linkAsync" : method === "symlink" ? "symlinkAsync" : "renameAsync";
      const original = fs[operation];
      const failure = Object.assign(new Error("deployment storage failure"), { code: "EIO" });
      const fault = vi
        .spyOn(fs, operation)
        .mockImplementation((from: string, to: string) =>
          from === source && to === target ? PromiseBB.reject(failure) : original(from, to),
        );

      const remaining = await h.deploy(changed);
      expect(fault).toHaveBeenCalledWith(source, target);
      expect(remaining).toEqual([
        expect.objectContaining({ relPath: "other.ini", source: "SomeMod" }),
      ]);
      expect(nodeFs.readFileSync(h.inGame("other.ini"), "utf8")).toBe("other mod");
      expect(nodeFs.readFileSync(target, "utf8")).toBe("original");
      expect(nodeFs.existsSync(target + BACKUP_TAG)).toBe(false);
      expect(nodeFs.readFileSync(source, "utf8")).toBe("modded");
      expect(nodeFs.existsSync(source + ".vortex_lnk")).toBe(false);
      expect(
        h.dispatched.filter((action) => action.type === String(addDeploymentFailures)),
      ).toEqual([
        addDeploymentFailures("skyrimse", [
          { source: "SomeMod", relPath: "config.ini", outputPath: target },
        ]),
      ]);

      vi.restoreAllMocks();
      const retried = await h.deploy(remaining);
      expect(retried).toHaveLength(2);
      expect(nodeFs.readFileSync(target, "utf8")).toBe("modded");
      await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
      expect(nodeFs.readFileSync(target, "utf8")).toBe("original");
      expect(nodeFs.existsSync(h.inGame("other.ini"))).toBe(false);
    });
  }

  test(`${method} keeps a file created while deployment fails and preserves its backup`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ method, files: { "config.ini": "modded" } });
    const target = h.inGame("config.ini");
    const source = path.join(h.stagingDir, "SomeMod", "config.ini");
    nodeFs.writeFileSync(target, "original");
    const operation =
      method === "hardlink" ? "linkAsync" : method === "symlink" ? "symlinkAsync" : "renameAsync";
    const original = fs[operation];
    const failure = Object.assign(new Error("deployment storage failure"), { code: "EIO" });
    vi.spyOn(fs, operation).mockImplementation((from: string, to: string) => {
      if (from !== source || to !== target) return original(from, to);
      nodeFs.writeFileSync(target, "external changes");
      return PromiseBB.reject(failure);
    });

    expect(await h.deploy()).toEqual([]);
    expect(nodeFs.readFileSync(target, "utf8")).toBe("external changes");
    expect(nodeFs.readFileSync(target + BACKUP_TAG, "utf8")).toBe("original");
    expect(nodeFs.readFileSync(source, "utf8")).toBe("modded");
    expect(nodeFs.existsSync(source + ".vortex_lnk")).toBe(false);
    expect(h.dialogCalls).toEqual([]);
  });
}

for (const step of ["write", "timestamps"]) {
  test(`move deployment cleans up after a placeholder ${step} failure`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ method: "move", files: { "config.ini": "modded" } });
    const target = h.inGame("config.ini");
    const source = path.join(h.stagingDir, "SomeMod", "config.ini");
    nodeFs.writeFileSync(target, "original");
    const failure = Object.assign(new Error("placeholder storage failure"), { code: "EIO" });
    if (step === "write") {
      const write = fs.writeFileAsync;
      vi.spyOn(fs, "writeFileAsync").mockImplementation((file, ...args) => {
        if (file !== source + ".vortex_lnk") return write(file, ...args);
        return write(file, "partial").then(() => {
          throw failure;
        });
      });
    } else {
      const utimes = fs.utimesAsync;
      vi.spyOn(fs, "utimesAsync").mockImplementation((file, ...args) =>
        file === source + ".vortex_lnk" ? PromiseBB.reject(failure) : utimes(file, ...args),
      );
    }

    expect(await h.deploy()).toEqual([]);
    expect(nodeFs.readFileSync(target, "utf8")).toBe("original");
    expect(nodeFs.readFileSync(source, "utf8")).toBe("modded");
    expect(nodeFs.existsSync(source + ".vortex_lnk")).toBe(false);
    expect(nodeFs.existsSync(target + BACKUP_TAG)).toBe(false);
    vi.restoreAllMocks();
    expect(await h.deploy()).toHaveLength(1);
    await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
    expect(nodeFs.readFileSync(target, "utf8")).toBe("original");
  });
}

for (const action of ["purge", "redeploy"]) {
  test(`move ${action} preserves both files when failed deployment leaves a stale placeholder`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ method: "move", files: { "config.ini": "modded" } });
    const target = h.inGame("config.ini");
    const source = path.join(h.stagingDir, "SomeMod", "config.ini");
    nodeFs.writeFileSync(target, "original");
    const rename = fs.renameAsync;
    const remove = fs.removeAsync;
    const failure = Object.assign(new Error("deployment storage failure"), { code: "EIO" });
    vi.spyOn(fs, "renameAsync").mockImplementation((from, to) =>
      from === source && to === target ? PromiseBB.reject(failure) : rename(from, to),
    );
    vi.spyOn(fs, "removeAsync").mockImplementation((file, ...args) =>
      file === source + ".vortex_lnk" ? PromiseBB.reject(failure) : remove(file, ...args),
    );

    expect(await h.deploy()).toEqual([]);
    expect(nodeFs.readFileSync(target, "utf8")).toBe("original");
    expect(nodeFs.readFileSync(source, "utf8")).toBe("modded");
    expect(nodeFs.existsSync(source + ".vortex_lnk")).toBe(true);
    vi.restoreAllMocks();

    if (action === "purge") {
      await expect(h.method.purge(h.stagingDir, h.gameDir, "skyrimse")).rejects.toMatchObject({
        code: "EEXIST",
      });
      expect(nodeFs.readFileSync(target, "utf8")).toBe("original");
      expect(nodeFs.readFileSync(source, "utf8")).toBe("modded");
      expect(nodeFs.existsSync(source + ".vortex_lnk")).toBe(true);
    } else {
      expect(await h.deploy()).toHaveLength(1);
      expect(nodeFs.readFileSync(target, "utf8")).toBe("modded");
      expect(nodeFs.readFileSync(target + BACKUP_TAG, "utf8")).toBe("original");
      await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
      expect(nodeFs.readFileSync(target, "utf8")).toBe("original");
      expect(nodeFs.readFileSync(source, "utf8")).toBe("modded");
    }
  });
}

test("deployment waits for directory cleanup before finishing or starting another deployment", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "nested/config.ini": "modded" } });
  const manifest = await h.deploy();
  await h.method.prepare(h.gameDir, true, manifest, h.normalize);
  let startCleanup: () => void;
  let releaseCleanup: () => void;
  const started = new Promise<void>((resolve) => {
    startCleanup = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const original = fs.rmdirAsync;
  const events: string[] = [];
  let cleanup: PromiseLike<void>;
  vi.spyOn(fs, "rmdirAsync").mockImplementation((directory, ...args) => {
    if (directory !== h.inGame("nested")) return original(directory, ...args);
    startCleanup();
    cleanup = PromiseBB.resolve(release)
      .then(() => original(directory, ...args))
      .then(() => {
        events.push("cleanup finished");
      });
    return PromiseBB.resolve(cleanup);
  });

  const deployment = Promise.resolve(h.method.finalize("skyrimse", h.gameDir, h.stagingDir)).then(
    () => {
      events.push("deployment finished");
    },
  );
  const next = Promise.resolve(h.method.prepare(h.gameDir, true, [], h.normalize)).then(() => {
    events.push("next started");
  });
  try {
    await started;
  } finally {
    releaseCleanup();
    await cleanup;
    await deployment;
    await next;
    await h.method.cancel("skyrimse", h.gameDir, h.stagingDir);
  }
  expect(events).toHaveLength(3);
  expect(events[0]).toBe("cleanup finished");
  expect(nodeFs.existsSync(h.inGame("nested"))).toBe(false);
});
