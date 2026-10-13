import * as nodeFs from "node:fs";
import * as path from "node:path";

import { expect } from "vitest";

import { test } from "../../test-utils/deploymentTest";

test("purge removes deployed hardlinks and preserves staged and unrelated files", async ({
  makeDeployment,
}) => {
  const files = { "mod.txt": "mod", "nested/.hidden.txt": "hidden mod" };
  const h = makeDeployment({ files });
  const original = h.inGame("original.txt");
  const unrelatedLink = h.inGame("unrelated-link.txt");
  nodeFs.writeFileSync(original, "game data");
  nodeFs.linkSync(original, unrelatedLink);
  await h.deploy();

  for (const relPath of Object.keys(files)) {
    expect(nodeFs.statSync(h.inGame(relPath)).nlink).toBe(2);
  }

  await h.method.prePurge(h.stagingDir);
  await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
  await h.method.postPurge();

  expect(h.deployedFiles()).toEqual([]);
  for (const [relPath, content] of Object.entries(files)) {
    const staged = path.join(h.stagingDir, "SomeMod", relPath);
    expect(nodeFs.readFileSync(staged, "utf8")).toBe(content);
    expect(nodeFs.statSync(staged).nlink).toBe(1);
  }
  expect(nodeFs.readFileSync(original, "utf8")).toBe("game data");
  expect(nodeFs.readFileSync(unrelatedLink, "utf8")).toBe("game data");
  expect(nodeFs.statSync(unrelatedLink).nlink).toBe(2);
});

test("purge restores an original file replaced by a deployed hardlink", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "config.ini": "mod config" } });
  nodeFs.writeFileSync(h.inGame("config.ini"), "original config");
  await h.deploy();
  expect(nodeFs.readFileSync(h.inGame("config.ini"), "utf8")).toBe("mod config");

  await h.method.prePurge(h.stagingDir);
  await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
  await h.method.postPurge();

  expect(nodeFs.readFileSync(h.inGame("config.ini"), "utf8")).toBe("original config");
  const staged = path.join(h.stagingDir, "SomeMod", "config.ini");
  expect(nodeFs.readFileSync(staged, "utf8")).toBe("mod config");
  expect(nodeFs.statSync(staged).nlink).toBe(1);
});

test("purge removes hardlinked symbolic links without following unrelated symbolic links", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "target.txt": "mod target" } });
  const stagedTarget = path.join(h.stagingDir, "SomeMod", "target.txt");
  const stagedAlias = path.join(h.stagingDir, "SomeMod", "alias.txt");
  const deployedAlias = h.inGame("alias.txt");
  const unrelatedLink = h.inGame("unrelated-link.txt");
  nodeFs.symlinkSync("target.txt", stagedAlias);
  nodeFs.symlinkSync(stagedTarget, unrelatedLink);
  await h.deploy();

  expect(nodeFs.lstatSync(deployedAlias).isSymbolicLink()).toBe(true);
  expect(nodeFs.lstatSync(deployedAlias).ino).toBe(nodeFs.lstatSync(stagedAlias).ino);
  expect(nodeFs.lstatSync(deployedAlias).nlink).toBe(2);

  await h.method.prePurge(h.stagingDir);
  await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
  await h.method.postPurge();

  expect(nodeFs.lstatSync(deployedAlias, { throwIfNoEntry: false })).toBeUndefined();
  expect(nodeFs.lstatSync(stagedAlias).isSymbolicLink()).toBe(true);
  expect(nodeFs.lstatSync(stagedAlias).nlink).toBe(1);
  expect(nodeFs.readFileSync(stagedAlias, "utf8")).toBe("mod target");
  expect(nodeFs.readlinkSync(unrelatedLink)).toBe(stagedTarget);
});
