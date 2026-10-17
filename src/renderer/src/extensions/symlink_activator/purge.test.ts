import * as fs from "node:fs";
import * as path from "node:path";

import { expect } from "vitest";

import { test } from "../../test-utils/deploymentTest";

test("purges links to double-dot staging names and preserves links outside staging", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({
    method: "symlink",
    modName: "..Mod",
    files: { "config.ini": "mod config" },
  });
  await h.deploy();
  const outside = path.join(path.dirname(h.stagingDir), "outside.ini");
  fs.writeFileSync(outside, "unrelated");
  fs.symlinkSync(outside, h.inGame("outside-link.ini"));
  await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
  expect(fs.existsSync(h.inGame("config.ini"))).toBe(false);
  expect(fs.readFileSync(path.join(h.stagingDir, "..Mod", "config.ini"), "utf8")).toBe(
    "mod config",
  );
  expect(fs.readlinkSync(h.inGame("outside-link.ini"))).toBe(outside);
});

test("purges relative links into staging and preserves relative links outside staging", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ method: "symlink", files: { "config.ini": "mod config" } });
  const staged = path.join(h.stagingDir, "SomeMod", "config.ini");
  fs.symlinkSync(path.relative(h.gameDir, staged), h.inGame("relative-link.ini"));
  const outside = path.join(path.dirname(h.stagingDir), "outside.ini");
  fs.writeFileSync(outside, "unrelated");
  const relative = path.relative(h.gameDir, outside);
  fs.symlinkSync(relative, h.inGame("outside-link.ini"));
  await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
  expect(fs.existsSync(h.inGame("relative-link.ini"))).toBe(false);
  expect(fs.readFileSync(staged, "utf8")).toBe("mod config");
  expect(fs.readlinkSync(h.inGame("outside-link.ini"))).toBe(relative);
});
