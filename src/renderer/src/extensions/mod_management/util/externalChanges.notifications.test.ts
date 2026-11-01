import * as nodeFs from "node:fs";
import * as path from "node:path";

import { expect, vi } from "vitest";

import { makeMod, makeProfile } from "../../../test-utils/builders";
import { test } from "../../../test-utils/deploymentTest";
import { dealWithExternalChanges } from "./externalChanges";

test("external changes notify the selected profile's game while another game is active", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({
    files: { "config.ini": "mod data" },
    profiles: {
      selected: makeProfile({ id: "selected", gameId: "skyrimse" }),
      other: makeProfile({ id: "other", gameId: "another-game" }),
    },
    activeProfileId: "other",
    mods: { skyrimse: { "record-id": makeMod({ id: "record-id", installationPath: "SomeMod" }) } },
  });
  const manifest = await h.deploy();
  nodeFs.unlinkSync(path.join(h.stagingDir, "SomeMod", "config.ini"));
  const emit = vi.spyOn(h.api.events, "emit");

  await dealWithExternalChanges(
    h.api,
    h.method,
    "selected",
    h.stagingDir,
    { "": h.gameDir },
    { "": manifest },
    new Set(["SomeMod"]),
  );

  expect(nodeFs.existsSync(h.inGame("config.ini"))).toBe(false);
  expect(emit).toHaveBeenCalledWith("mod-content-changed", "skyrimse", "record-id");
  expect(emit).toHaveBeenCalledWith("check-file-override-redundancies", "skyrimse", {
    "record-id": [h.inGame("config.ini")],
  });
  expect(emit).not.toHaveBeenCalledWith("mod-content-changed", "selected", "record-id");
  expect(emit).not.toHaveBeenCalledWith("mod-content-changed", "another-game", "record-id");
});
