import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import turbowalk, { type IEntry, type IWalkOptions } from "turbowalk";
import { afterEach, beforeEach, expect, it } from "vitest";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nyastra-walker-"));
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "root.txt"), "root");
  await writeFile(path.join(root, "nested", "child.txt"), "child");
});
afterEach(async () => rm(root, { recursive: true, force: true }));

async function collect(options?: IWalkOptions) {
  const entries: IEntry[] = [];
  await turbowalk(
    root,
    (batch) => {
      entries.push(...batch);
    },
    options,
  );
  return entries;
}

it("honors nonrecursive walks used to decide which game directories may be removed", async () => {
  const names = (await collect({ recurse: false })).map((entry) =>
    path.relative(root, entry.filePath),
  );
  expect(names.sort()).toEqual(["nested", "root.txt"]);
  expect(await readFile(path.join(root, "nested", "child.txt"), "utf8")).toBe("child");
});

it("reports modification time in seconds for deployment manifests", async () => {
  await utimes(path.join(root, "root.txt"), 1000, 2000.5);
  const file = (await collect()).find((entry) => entry.filePath === path.join(root, "root.txt"))!;
  expect(file.mtime * 1000).toBe(2_000_500);
});

it("provides link metadata for manual mod detection", async () => {
  await link(path.join(root, "root.txt"), path.join(root, "linked.txt"));
  await symlink("missing", path.join(root, "dangling"));
  const entries = await collect({ details: true });
  const file = entries.find((entry) => entry.filePath === path.join(root, "root.txt"))!;
  const linked = entries.find((entry) => entry.filePath === path.join(root, "linked.txt"))!;
  expect(file.linkCount).toBe(2);
  expect(file.idStr).toBeDefined();
  expect(linked.idStr).toBe(file.idStr);
  expect(
    entries.find((entry) => entry.filePath === path.join(root, "dangling"))?.isReparsePoint,
  ).toBe(true);
});

it("includes hidden mod files when requested and skips them by default", async () => {
  await writeFile(path.join(root, ".hidden"), "hidden");
  expect((await collect()).some((entry) => entry.filePath === path.join(root, ".hidden"))).toBe(
    false,
  );
  expect(
    (await collect({ skipHidden: false })).some(
      (entry) => entry.filePath === path.join(root, ".hidden"),
    ),
  ).toBe(true);
});

it("marks completed directories for game discovery progress", async () => {
  const entries = await collect({ terminators: true });
  const completed = entries.filter((entry) => entry.isTerminator).map((entry) => entry.filePath);
  expect(completed).toEqual([path.join(root, "nested"), root]);
});

it("skips inaccessible directories only when requested", async () => {
  const restricted = path.join(root, "nested");
  await chmod(restricted, 0);
  try {
    await expect(collect({ skipInaccessible: false })).rejects.toMatchObject({ code: "EACCES" });
    const entries = await collect({ skipInaccessible: true });
    expect(entries.some((entry) => entry.filePath === path.join(root, "root.txt"))).toBe(true);
  } finally {
    await chmod(restricted, 0o700);
  }
});

it("rejects inaccessible file metadata during a strict walk", async () => {
  const restricted = path.join(root, "nested");
  await chmod(restricted, 0o400);
  try {
    await expect(collect({ skipInaccessible: false })).rejects.toMatchObject({ code: "EACCES" });
    await expect(collect({ skipInaccessible: true })).resolves.toBeDefined();
  } finally {
    await chmod(restricted, 0o700);
  }
});
