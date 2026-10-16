import { existsSync } from "node:fs";
import { link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type * as FsExtra from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const metadata = vi.hoisted(() => ({ stat: vi.fn() }));

vi.mock("fs-extra", async (importOriginal) => {
  const actual = await importOriginal<typeof FsExtra & { default?: typeof FsExtra }>();
  const base = actual.default ?? actual;
  return { ...base, default: { ...base, stat: metadata.stat }, stat: metadata.stat };
});

import { SelfCopyCheckError } from "./CustomErrors";
import { copyAsync } from "./fs";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nyastra-file-identity-"));
  metadata.stat.mockImplementation((filename: string) => stat(filename, { bigint: true }));
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe("copy file identity", () => {
  it.runIf(process.platform === "linux" && existsSync("/dev/shm"))(
    "copies between actual Linux filesystems",
    async ({ skip }) => {
      const other = await mkdtemp("/dev/shm/nyastra-file-identity-");
      try {
        if ((await stat(root)).dev === (await stat(other)).dev) {
          skip("A second filesystem is unavailable");
          return;
        }
        const source = path.join(root, "source.txt");
        const destination = path.join(other, "destination.txt");
        await writeFile(source, "cross filesystem content");
        await writeFile(destination, "old content");

        await copyAsync(source, destination);

        expect(await readFile(destination, "utf8")).toBe("cross filesystem content");
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    },
  );

  it("copies files with matching inode numbers on different devices", async () => {
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    await writeFile(source, "new content");
    await writeFile(destination, "old content");
    metadata.stat.mockImplementation(async (filename: string) => ({
      ...(await stat(filename, { bigint: true })),
      ino: 9007199254740993n,
      dev: filename === source ? 1n : 2n,
    }));

    await copyAsync(source, destination);

    expect(await readFile(destination, "utf8")).toBe("new content");
    expect(await readFile(source, "utf8")).toBe("new content");
  });

  it("still rejects an actual hardlink to the source file", async () => {
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "alias.txt");
    await writeFile(source, "preserved");
    await link(source, destination);

    await expect(copyAsync(source, destination)).rejects.toBeInstanceOf(SelfCopyCheckError);
    expect(await readFile(source, "utf8")).toBe("preserved");
  });
});
