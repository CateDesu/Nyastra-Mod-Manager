import * as nodeFs from "node:fs";
import * as path from "node:path";

import { expect } from "vitest";

import { test } from "../../test-utils/deploymentTest";

for (const method of ["hardlink", "symlink", "move"] as const) {
  test(`${method} keeps active normalization until a queued deployment starts`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ method, files: { "Config.ini": "mod data" } });
    const manifest = await h.deploy();
    const modDir = path.join(h.stagingDir, "SomeMod");
    await h.method.prepare(h.gameDir, false, manifest, h.normalize);
    let secondStarted = false;
    const queued = Promise.resolve(h.method.prepare(h.gameDir, true, [], (input) => input)).then(
      () => {
        secondStarted = true;
      },
    );
    try {
      expect(secondStarted).toBe(false);
      await h.method.deactivate(modDir, "", "SomeMod");
      const remaining = await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
      await queued;

      expect(remaining).toEqual([]);
      expect(nodeFs.existsSync(h.inGame("Config.ini"))).toBe(false);
      expect(nodeFs.readFileSync(path.join(modDir, "Config.ini"), "utf8")).toBe("mod data");
      expect(secondStarted).toBe(true);
    } finally {
      await h.method.cancel("skyrimse", h.gameDir, h.stagingDir);
      await queued;
      await h.method.cancel("skyrimse", h.gameDir, h.stagingDir);
    }
  });
}
