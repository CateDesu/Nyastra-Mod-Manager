import * as nodeFs from "node:fs";
import * as path from "node:path";

import { afterEach, expect, vi } from "vitest";

import { test } from "../../test-utils/deploymentTest";
import * as fs from "../../util/fs";
import { BACKUP_TAG } from "../mod_management/LinkingDeployment";

afterEach(() => vi.restoreAllMocks());

function simulateInodeCollision(destination: string, source: string): void {
  const sourceStats = nodeFs.statSync(source);
  const lstat = fs.lstatAsync;
  vi.spyOn(fs, "lstatAsync").mockImplementation((filename) =>
    lstat(filename).then((stats) =>
      filename === destination
        ? Object.assign(stats, { ino: sourceStats.ino, dev: sourceStats.dev + 1 })
        : stats,
    ),
  );
}

for (const device of ["same device", "different device"]) {
  test(`reports an external change for an unrelated hardlink on the ${device}`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ files: { "mod.txt": "mod content" } });
    const source = path.join(h.stagingDir, "SomeMod/mod.txt");
    const destination = h.inGame("mod.txt");
    nodeFs.writeFileSync(destination, "game content");
    nodeFs.linkSync(destination, h.inGame("unrelated-link.txt"));
    if (device === "different device") simulateInodeCollision(destination, source);

    expect(
      await h.method.externalChanges("skyrimse", h.stagingDir, h.gameDir, h.manifest()),
    ).toEqual([
      {
        filePath: "mod.txt",
        source: "SomeMod",
        changeType: "refchange",
        sourceTime: expect.any(Date),
        destTime: expect.any(Date),
      },
    ]);
    expect(nodeFs.readFileSync(destination, "utf8")).toBe("game content");
    expect(nodeFs.readFileSync(source, "utf8")).toBe("mod content");
  });

  test(`backs up an unrelated game file on the ${device}`, async ({ makeDeployment }) => {
    const h = makeDeployment({ files: { "mod.txt": "mod content" } });
    const source = path.join(h.stagingDir, "SomeMod/mod.txt");
    const destination = h.inGame("mod.txt");
    const unrelated = h.inGame("unrelated-link.txt");
    nodeFs.writeFileSync(destination, "original game content");
    nodeFs.linkSync(destination, unrelated);
    if (device === "different device") simulateInodeCollision(destination, source);

    await h.deploy();

    expect(nodeFs.readFileSync(destination + BACKUP_TAG, "utf8")).toBe("original game content");
    expect(nodeFs.readFileSync(unrelated, "utf8")).toBe("original game content");
    expect(nodeFs.readFileSync(destination, "utf8")).toBe("mod content");
    expect(nodeFs.statSync(destination).ino).toBe(nodeFs.statSync(source).ino);
    expect(nodeFs.statSync(destination).dev).toBe(nodeFs.statSync(source).dev);
  });
}

test("recognizes an actual deployed hardlink when checking external changes", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "mod.txt": "mod content" } });
  const manifest = await h.deploy();

  expect(await h.method.externalChanges("skyrimse", h.stagingDir, h.gameDir, manifest)).toEqual([]);
});

test("redeploys an actual hardlink without backing it up as an original game file", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "mod.txt": "mod content" } });
  const source = path.join(h.stagingDir, "SomeMod/mod.txt");
  const destination = h.inGame("mod.txt");
  await h.deploy();

  await h.deploy();

  expect(nodeFs.existsSync(destination + BACKUP_TAG)).toBe(false);
  expect(nodeFs.readFileSync(destination, "utf8")).toBe("mod content");
  expect(nodeFs.statSync(destination).ino).toBe(nodeFs.statSync(source).ino);
  expect(nodeFs.statSync(source).nlink).toBe(2);
});
