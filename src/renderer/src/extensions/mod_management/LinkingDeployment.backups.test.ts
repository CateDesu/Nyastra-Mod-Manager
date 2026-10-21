import * as nodeFs from "node:fs";

import { expect, vi } from "vitest";

import { test, type DeploymentMethodName } from "../../test-utils/deploymentTest";
import * as fsAtomic from "../../util/fsAtomic";
import { addDeploymentFailures } from "./actions/session";
import { BACKUP_TAG } from "./LinkingDeployment";

for (const method of ["hardlink", "symlink", "move"] satisfies DeploymentMethodName[]) {
  test(`${method} asks before replacing an external file with a backup on purge`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ method, files: {} });
    const target = h.inGame("config.ini");
    nodeFs.writeFileSync(target, "external changes");
    nodeFs.writeFileSync(target + BACKUP_TAG, "original");
    h.setNextDialog({ action: "Keep Existing File", input: {} });

    await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");

    expect(nodeFs.readFileSync(target, "utf8")).toBe("external changes");
    expect(h.dialogCalls).toEqual([{ type: "question", title: "Confirm" }]);
    expect(nodeFs.existsSync(target + BACKUP_TAG)).toBe(false);
  });

  test(`${method} restores a backup only after the user selects it`, async ({ makeDeployment }) => {
    const h = makeDeployment({ method, files: {} });
    const target = h.inGame("config.ini");
    nodeFs.writeFileSync(target, "external changes");
    nodeFs.writeFileSync(target + BACKUP_TAG, "original");
    h.setNextDialog({ action: "Restore Vortex Backup", input: {} });

    await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");

    expect(h.dialogCalls).toHaveLength(1);
    expect(nodeFs.readFileSync(target, "utf8")).toBe("original");
    expect(nodeFs.existsSync(target + BACKUP_TAG)).toBe(false);
  });

  test(`${method} preserves both existing files when a deployment backup is already occupied`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ method, files: { "config.ini": "modded" } });
    const target = h.inGame("config.ini");
    nodeFs.writeFileSync(target, "external changes");
    nodeFs.writeFileSync(target + BACKUP_TAG, "original");

    expect(await h.deploy()).toEqual([]);

    expect(nodeFs.readFileSync(target, "utf8")).toBe("external changes");
    expect(nodeFs.readFileSync(target + BACKUP_TAG, "utf8")).toBe("original");
    expect(
      h.dispatched.filter((action) => action.type === String(addDeploymentFailures)),
    ).toHaveLength(1);
  });

  test(`${method} retains a failed backup restoration for retry`, async ({ makeDeployment }) => {
    const h = makeDeployment({ method, files: { "config.ini": "modded" } });
    const target = h.inGame("config.ini");
    nodeFs.writeFileSync(target, "original");
    const manifest = await h.deploy();
    expect(nodeFs.readFileSync(target, "utf8")).toBe("modded");
    expect(nodeFs.readFileSync(target + BACKUP_TAG, "utf8")).toBe("original");

    await h.method.prepare(h.gameDir, true, manifest, h.normalize);
    const fault = Object.assign(new Error("backup storage failure"), { code: "EIO" });
    const originalMove = fsAtomic.moveFileNoReplace;
    const rename = vi
      .spyOn(fsAtomic, "moveFileNoReplace")
      .mockImplementation((source, destination) =>
        source === target + BACKUP_TAG ? Promise.reject(fault) : originalMove(source, destination),
      );
    let remaining;
    try {
      remaining = await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
    } finally {
      rename.mockRestore();
    }

    expect(remaining).toEqual(manifest);
    expect(
      h.dispatched.filter((action) => action.type === String(addDeploymentFailures)),
    ).toHaveLength(1);
    expect(nodeFs.existsSync(target)).toBe(false);
    expect(nodeFs.readFileSync(target + BACKUP_TAG, "utf8")).toBe("original");

    await h.method.prepare(h.gameDir, true, remaining, h.normalize);
    expect(await h.method.finalize("skyrimse", h.gameDir, h.stagingDir)).toEqual([]);
    expect(nodeFs.readFileSync(target, "utf8")).toBe("original");
    expect(nodeFs.existsSync(target + BACKUP_TAG)).toBe(false);
  });
}
