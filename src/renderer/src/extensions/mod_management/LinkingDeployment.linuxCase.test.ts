import * as fs from "node:fs";
import * as path from "node:path";

import { expect } from "vitest";

import { test } from "../../test-utils/deploymentTest";

test("deploys into existing directory casing and restores the original file on purge", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "textures/Armor.dds": "modded" } });
  const original = h.inGame("Textures/armor.dds");
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, "original");
  const deployed = await h.deploy();
  expect(fs.readFileSync(original, "utf8")).toBe("modded");
  expect(fs.existsSync(h.inGame("textures"))).toBe(false);
  expect(await h.method.externalChanges("skyrimse", h.stagingDir, h.gameDir, deployed)).toEqual([]);
  await h.method.prepare(h.gameDir, true, deployed, h.normalize);
  await h.method.finalize("skyrimse", h.gameDir, h.stagingDir);
  expect(fs.readFileSync(original, "utf8")).toBe("original");
  expect(fs.readdirSync(path.dirname(original))).toEqual(["armor.dds"]);
});

test("parallel deployment creates one shared directory for differently cased mod paths", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "textures/One.dds": "one", "Textures/Two.dds": "two" } });
  await h.deploy();
  const directories = fs.readdirSync(h.gameDir).filter((name) => name.toLowerCase() === "textures");
  expect(directories).toHaveLength(1);
  expect(fs.readFileSync(path.join(h.gameDir, directories[0], "One.dds"), "utf8")).toBe("one");
  expect(fs.readFileSync(path.join(h.gameDir, directories[0], "Two.dds"), "utf8")).toBe("two");
});
