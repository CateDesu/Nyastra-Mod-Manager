import fs from "node:fs";
import path from "node:path";

import { expect } from "vitest";

import { test } from "../../test-utils/deploymentTest";
import { getGame } from "../gamemode_management/util/getGame";
import { addDeploymentFailures } from "./actions/session";
import { BACKUP_TAG } from "./LinkingDeployment";
import BlacklistSet from "./util/BlacklistSet";

for (const method of ["hardlink", "symlink", "move"] as const) {
  test(`${method} applies a new override to previously deployed files`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ method, files: { "config.ini": "modded" } });
    fs.writeFileSync(h.inGame("config.ini"), "original");
    const manifest = await h.deploy();
    const modPath = path.join(h.stagingDir, "SomeMod");
    const skip = new BlacklistSet(
      [h.normalize("SomeMod/config.ini")],
      getGame("skyrimse"),
      h.normalize,
    );

    await h.method.prepare(h.gameDir, true, manifest, h.normalize);
    await h.method.activate(modPath, "SomeMod", "", skip);
    const result = await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);

    expect(fs.readFileSync(h.inGame("config.ini"), "utf8")).toBe("original");
    expect(result).toEqual([]);
    expect(fs.readFileSync(path.join(modPath, "config.ini"), "utf8")).toBe("modded");
  });
}

test("separate type manifests cannot overwrite an occupied original backup", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "config.ini": "first mod" } });
  fs.writeFileSync(h.inGame("config.ini"), "original");
  await h.deploy();
  const second = path.join(h.stagingDir, "Second");
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(second, "config.ini"), "second mod");

  await h.method.prepare(h.gameDir, true, [], h.normalize);
  await h.method.activate(
    second,
    "Second",
    "",
    new BlacklistSet([], getGame("skyrimse"), h.normalize),
  );
  expect(await h.method.finalize("skyrimse", h.gameDir, h.stagingDir)).toEqual([]);

  expect(fs.readFileSync(h.inGame("config.ini"), "utf8")).toBe("first mod");
  expect(fs.readFileSync(h.inGame("config.ini") + BACKUP_TAG, "utf8")).toBe("original");
  expect(
    h.dispatched.filter((action) => action.type === String(addDeploymentFailures)),
  ).toHaveLength(1);
  await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
  expect(fs.readFileSync(h.inGame("config.ini"), "utf8")).toBe("original");
});
