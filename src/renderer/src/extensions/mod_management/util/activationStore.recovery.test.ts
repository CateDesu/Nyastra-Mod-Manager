import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, expect, vi } from "vitest";

import { test } from "../../../test-utils/deploymentTest";
import { UserCanceled } from "../../../util/CustomErrors";
import { transferPath } from "../../../util/transferPath";
import { fallbackPurgeType, saveActivation } from "./activationStore";
import * as methods from "./deploymentMethods";

afterEach(() => vi.restoreAllMocks());

test("canceling an unsafe fallback purge preserves moved files and the manifest", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ method: "move", files: { "config.ini": "only mod copy" } });
  const files = await h.deploy();
  vi.spyOn(h.api.store, "getState").mockReturnValue({
    ...h.api.store.getState(),
    app: { instanceId: "review" },
  } as any);
  expect(Math.abs(files[0].time - fs.statSync(h.inGame("config.ini")).mtimeMs)).toBeLessThan(1);
  await saveActivation("skyrimse", "", "review", h.gameDir, h.stagingDir, files, h.method.id);
  vi.spyOn(methods, "getActivator").mockReturnValue(h.method);
  vi.spyOn(h.api.store, "dispatch").mockResolvedValue({ action: "Cancel" } as never);

  await expect(
    fallbackPurgeType(h.api, h.method, "skyrimse", "", h.gameDir, h.stagingDir),
  ).rejects.toBeInstanceOf(UserCanceled);
  expect(fs.readFileSync(h.inGame("config.ini"), "utf8")).toBe("only mod copy");
  expect(fs.existsSync(h.inGame("vortex.deployment.json"))).toBe(true);
  expect(fs.existsSync(path.join(h.stagingDir, "SomeMod", "config.ini.vortex_lnk"))).toBe(true);
});

test("fallback purge recovers a damaged manifest from the backup written by saveActivation", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "config.ini": "mod copy" } });
  const files = await h.deploy();
  vi.spyOn(h.api.store, "getState").mockReturnValue({
    ...h.api.store.getState(),
    app: { instanceId: "review" },
  } as any);
  expect(Math.abs(files[0].time - fs.statSync(h.inGame("config.ini")).mtimeMs)).toBeLessThan(1);
  await saveActivation("skyrimse", "", "review", h.gameDir, h.stagingDir, files, h.method.id);
  fs.writeFileSync(h.inGame("vortex.deployment.json"), "damaged");
  vi.spyOn(methods, "getActivator").mockReturnValue(h.method);
  vi.spyOn(h.api, "showDialog").mockResolvedValue({ action: "Restore from backup", input: {} });

  await fallbackPurgeType(h.api, h.method, "skyrimse", "", h.gameDir, h.stagingDir);
  expect(fs.existsSync(h.inGame("config.ini"))).toBe(false);
  expect(fs.readFileSync(path.join(h.stagingDir, "SomeMod", "config.ini"), "utf8")).toBe(
    "mod copy",
  );
  expect(fs.existsSync(h.inGame("vortex.deployment.json"))).toBe(false);
});

test("purging a tagged subtree preserves unrelated empty game directories", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: {} });
  fs.mkdirSync(h.inGame("managed"));
  fs.writeFileSync(h.inGame("managed/.__folder_managed_by_vortex"), "");
  fs.mkdirSync(h.inGame("unmanaged"));

  await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");

  expect(fs.existsSync(h.inGame("managed"))).toBe(false);
  expect(fs.statSync(h.inGame("unmanaged")).isDirectory()).toBe(true);
});

for (const method of ["hardlink", "symlink", "move"] as const) {
  test(`${method} deactivates hidden mod files`, async ({ makeDeployment }) => {
    const h = makeDeployment({ method, files: { ".config.ini": "hidden mod" } });
    const files = await h.deploy();
    expect(fs.readFileSync(h.inGame(".config.ini"), "utf8")).toBe("hidden mod");
    await h.method.prepare(h.gameDir, false, files, h.normalize);
    await h.method.deactivate(path.join(h.stagingDir, "SomeMod"), "", "SomeMod");
    expect(await h.method.finalize("skyrimse", h.gameDir, h.stagingDir)).toEqual([]);
    expect(fs.existsSync(h.inGame(".config.ini"))).toBe(false);
    expect(fs.readFileSync(path.join(h.stagingDir, "SomeMod", ".config.ini"), "utf8")).toBe(
      "hidden mod",
    );
  });

  for (const mode of [0, 0o400]) {
    test(`${method} preserves source files when staging permissions are ${mode.toString(8)}`, async ({
      makeDeployment,
    }) => {
      const h = makeDeployment({ method, files: { "config.ini": "mod" } });
      await h.deploy();
      const modDir = path.join(h.stagingDir, "SomeMod");
      fs.chmodSync(modDir, mode);
      try {
        if (method === "symlink") {
          await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
          expect(fs.existsSync(h.inGame("config.ini"))).toBe(false);
        } else {
          await expect(h.method.purge(h.stagingDir, h.gameDir, "skyrimse")).rejects.toMatchObject({
            code: "EACCES",
          });
          expect(fs.existsSync(h.inGame("config.ini"))).toBe(true);
        }
      } finally {
        fs.chmodSync(modDir, 0o700);
      }
      const retainedFile =
        method === "move" ? h.inGame("config.ini") : path.join(modDir, "config.ini");
      expect(fs.readFileSync(retainedFile, "utf8")).toBe("mod");
    });
  }
}

test("transferring staging files includes hidden files and preserves their contents", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { ".config.ini": "hidden", "nested/file.txt": "nested" } });
  const source = path.join(h.stagingDir, "SomeMod");
  await transferPath(source, h.gameDir, () => {});
  expect(fs.readFileSync(h.inGame(".config.ini"), "utf8")).toBe("hidden");
  expect(fs.readFileSync(h.inGame("nested/file.txt"), "utf8")).toBe("nested");
  expect(fs.existsSync(source)).toBe(false);
});

for (const mode of [0, 0o400]) {
  test(`a transfer with unreadable staging permissions ${mode.toString(8)} preserves its source`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ files: { "nested/file.txt": "only copy" } });
    const source = path.join(h.stagingDir, "SomeMod");
    const restricted = path.join(source, "nested");
    fs.chmodSync(restricted, mode);
    try {
      await expect(transferPath(source, h.gameDir, () => {})).rejects.toMatchObject({
        code: "EACCES",
      });
    } finally {
      fs.chmodSync(restricted, 0o700);
    }
    expect(fs.readFileSync(path.join(restricted, "file.txt"), "utf8")).toBe("only copy");
  });
}
