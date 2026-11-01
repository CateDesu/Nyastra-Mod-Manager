import * as nodeFs from "node:fs";
import * as path from "node:path";

import { expect, vi } from "vitest";

import { makeProfile } from "../../../test-utils/builders";
import { test } from "../../../test-utils/deploymentTest";
import { confirmExternalChanges, setExternalChanges } from "../actions/session";
import type { IFileEntry } from "../types/IFileEntry";
import { dealWithExternalChanges } from "./externalChanges";

for (const action of ["drop", "import"] as const) {
  test(`external change ${action} uses the manifest target and retains another mod's same-named file`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({
      files: { "config.ini": "staged data" },
      profiles: { p: makeProfile({ id: "p" }) },
      activeProfileId: "p",
    });
    const modDir = path.join(h.stagingDir, "SomeMod");
    const otherDir = path.join(h.stagingDir, "OtherMod");
    nodeFs.mkdirSync(otherDir);
    nodeFs.writeFileSync(path.join(otherDir, "config.ini"), "other mod");
    nodeFs.writeFileSync(h.inGame("config.ini"), "unrelated game file");
    await h.method.prepare(h.gameDir, true, [], h.normalize);
    await h.method.activate(modDir, "SomeMod", "Selected", new Set());
    await h.method.activate(otherDir, "OtherMod", "Other", new Set());
    const manifest = await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
    nodeFs.unlinkSync(h.inGame("Selected/config.ini"));
    nodeFs.writeFileSync(h.inGame("Selected/config.ini"), "external data");
    const lastDeployment = { "": manifest };
    const resolving = dealWithExternalChanges(
      h.api,
      h.method,
      "p",
      h.stagingDir,
      { "": h.gameDir },
      lastDeployment,
    );
    try {
      await vi.waitFor(
        () =>
          expect(h.dispatched.some((entry) => entry.type === String(setExternalChanges))).toBe(
            true,
          ),
        { timeout: 1000 },
      );
      const entry = h.dispatched.find((entry) => entry.type === String(setExternalChanges));
      const choices = (entry.payload as IFileEntry[]).map((entry) => ({ ...entry, action }));
      expect(choices).toEqual([
        expect.objectContaining({ source: "SomeMod", filePath: "config.ini" }),
      ]);
      h.api.store.dispatch(confirmExternalChanges(choices, false));
      await resolving;

      expect.soft(nodeFs.readFileSync(h.inGame("config.ini"), "utf8")).toBe("unrelated game file");
      expect.soft(nodeFs.existsSync(h.inGame("Selected/config.ini"))).toBe(false);
      expect
        .soft(nodeFs.readFileSync(path.join(modDir, "config.ini"), "utf8"))
        .toBe(action === "import" ? "external data" : "staged data");
      expect.soft(nodeFs.readFileSync(h.inGame("Other/config.ini"), "utf8")).toBe("other mod");
      expect(lastDeployment[""]).toEqual([
        expect.objectContaining({ source: "OtherMod", target: "Other" }),
      ]);
    } finally {
      h.api.store.dispatch(confirmExternalChanges([], true));
      await resolving.catch(() => undefined);
    }
  });
}

test("external change detection keeps same-named files from distinct source mods", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "config.ini": "staged data" } });
  const modDir = path.join(h.stagingDir, "SomeMod");
  const otherDir = path.join(h.stagingDir, "OtherMod");
  nodeFs.mkdirSync(otherDir);
  nodeFs.writeFileSync(path.join(otherDir, "config.ini"), "other mod");
  await h.method.prepare(h.gameDir, true, [], h.normalize);
  await h.method.activate(modDir, "SomeMod", "Selected", new Set());
  await h.method.activate(otherDir, "OtherMod", "Other", new Set());
  const manifest = await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
  for (const directory of ["Selected", "Other"]) {
    nodeFs.unlinkSync(h.inGame(`${directory}/config.ini`));
    nodeFs.writeFileSync(h.inGame(`${directory}/config.ini`), "external data");
  }

  const changes = await h.method.externalChanges("skyrimse", h.stagingDir, h.gameDir, manifest);

  expect(
    changes
      .map((entry) => ({ source: entry.source, type: entry.changeType }))
      .sort((a, b) => a.source.localeCompare(b.source)),
  ).toEqual([
    { source: "OtherMod", type: "refchange" },
    { source: "SomeMod", type: "refchange" },
  ]);
});
