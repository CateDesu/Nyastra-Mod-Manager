import * as nodeFs from "node:fs";

import Bluebird from "bluebird";
import { expect, vi } from "vitest";

import { test, type DeploymentMethodName } from "../../test-utils/deploymentTest";
import * as fs from "../../util/fs";
import { addDeploymentFailures } from "./actions/session";
import { BACKUP_TAG } from "./LinkingDeployment";

for (const method of ["hardlink", "symlink", "move"] satisfies DeploymentMethodName[]) {
  test(`${method} retains a failed backup restoration for retry`, async ({ makeDeployment }) => {
    const h = makeDeployment({ method, files: { "config.ini": "modded" } });
    const target = h.inGame("config.ini");
    nodeFs.writeFileSync(target, "original");
    const manifest = await h.deploy();
    expect(nodeFs.readFileSync(target, "utf8")).toBe("modded");
    expect(nodeFs.readFileSync(target + BACKUP_TAG, "utf8")).toBe("original");

    await h.method.prepare(h.gameDir, true, manifest, h.normalize);
    const fault = Object.assign(new Error("backup storage failure"), { code: "EIO" });
    const originalRename = fs.renameAsync;
    const rename = vi
      .spyOn(fs, "renameAsync")
      .mockImplementation((source, destination) =>
        source === target + BACKUP_TAG
          ? Bluebird.reject(fault)
          : originalRename(source, destination),
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
