import * as nodeFs from "node:fs";
import { rename } from "node:fs/promises";
import type * as nodePromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Bluebird from "bluebird";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmpSpy = vi.hoisted((): { lastFileOpts?: Record<string, unknown> } => ({}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof nodePromises>();
  const rename = vi.fn(actual.rename);
  return { ...actual, default: { ...actual, rename }, rename };
});

vi.mock("tmp", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    file: (opts: Record<string, unknown>, cb: unknown) => {
      tmpSpy.lastFileOpts = opts;
      return (actual.file as (o: unknown, c: unknown) => void)(opts, cb);
    },
  };
});

import * as fs from "./fs";
import { copyFileAtomic, writeFileAtomic } from "./fsAtomic";

describe("copyFileAtomic", () => {
  let dir: string;

  beforeEach(() => {
    dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "fs-atomic-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(["copy", "write"])(
    "replaces files outside the system temp folder with %s",
    async (operation) => {
      const temp = path.join(dir, "system-temp");
      const staging = path.join(dir, "mod staging");
      nodeFs.mkdirSync(temp);
      nodeFs.mkdirSync(staging);
      for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, temp);
      const src = path.join(staging, "source.patch_0");
      const dest = path.join(staging, "dest.patch_0");
      nodeFs.writeFileSync(src, "new content");
      nodeFs.writeFileSync(dest, "old content");

      if (operation === "copy") await copyFileAtomic(src, dest);
      else await writeFileAtomic(dest, "new content");

      expect(nodeFs.readFileSync(dest, "utf8")).toBe("new content");
      expect(nodeFs.readdirSync(staging).sort()).toEqual(["dest.patch_0", "source.patch_0"]);
      expect(nodeFs.readdirSync(temp)).toEqual([]);
    },
  );

  it("closes the temporary descriptor and removes the file after a write failure", async () => {
    const dest = path.join(dir, "dest.txt");
    nodeFs.writeFileSync(dest, "old content");
    const descriptors: number[] = [];
    const fault = new Error("write storage failure");
    vi.spyOn(fs, "writeAsync").mockImplementation((fd) => {
      descriptors.push(fd);
      return Bluebird.reject(fault);
    });
    try {
      await expect(writeFileAtomic(dest, "new content")).rejects.toBe(fault);
      expect(nodeFs.readdirSync(dir)).toEqual(["dest.txt"]);
      for (const fd of descriptors) expect(() => nodeFs.fstatSync(fd)).toThrow();
      expect(nodeFs.readFileSync(dest, "utf8")).toBe("old content");
    } finally {
      for (const fd of descriptors) {
        try {
          nodeFs.closeSync(fd);
        } catch {
          /* Already closed. */
        }
      }
    }
  });

  it("removes failed temporary writes across checksum retries", async () => {
    const dest = path.join(dir, "dest.txt");
    nodeFs.writeFileSync(dest, "old content");
    const originalWrite = fs.writeAsync;
    vi.spyOn(fs, "writeAsync").mockImplementation((fd, buffer, offset, _length, position) =>
      originalWrite(fd, buffer, offset, 1, position),
    );
    await expect(writeFileAtomic(dest, "new content")).rejects.toThrow("checksums differ");
    expect(nodeFs.readFileSync(dest, "utf8")).toBe("old content");
    expect(nodeFs.readdirSync(dir)).toEqual(["dest.txt"]);
  });

  it("preserves the original if an atomic write cannot replace it", async () => {
    const dest = path.join(dir, "dest.txt");
    nodeFs.writeFileSync(dest, "old content");
    const fault = Object.assign(new Error("replace failure"), { code: "EEXIST" });
    vi.spyOn(fs, "renameAsync").mockImplementation(() => Bluebird.reject(fault));
    await expect(writeFileAtomic(dest, "new content")).rejects.toBe(fault);
    expect(nodeFs.readFileSync(dest, "utf8")).toBe("old content");
    expect(nodeFs.readdirSync(dir)).toEqual(["dest.txt"]);
  });

  it("preserves the old destination and removes the temporary copy when rename fails", async () => {
    const src = path.join(dir, "src.txt");
    const dest = path.join(dir, "dest.txt");
    nodeFs.writeFileSync(src, "new content");
    nodeFs.writeFileSync(dest, "old content");
    const failure = Object.assign(new Error("rename storage failure"), { code: "EIO" });
    vi.mocked(rename).mockRejectedValueOnce(failure);
    await expect(copyFileAtomic(src, dest)).rejects.toBe(failure);
    expect(nodeFs.readFileSync(dest, "utf8")).toBe("old content");
    expect(nodeFs.readdirSync(dir).sort()).toEqual(["dest.txt", "src.txt"]);
  });

  it("replaces the destination with the source content", async () => {
    const src = path.join(dir, "src.txt");
    const dest = path.join(dir, "dest.txt");
    nodeFs.writeFileSync(src, "new content");
    nodeFs.writeFileSync(dest, "old content");

    await copyFileAtomic(src, dest);

    expect(nodeFs.readFileSync(dest, "utf8")).toBe("new content");
  });

  it("creates the destination when it does not exist yet", async () => {
    const src = path.join(dir, "src.txt");
    const dest = path.join(dir, "dest.txt");
    nodeFs.writeFileSync(src, "new content");

    await copyFileAtomic(src, dest);

    expect(nodeFs.readFileSync(dest, "utf8")).toBe("new content");
  });

  it("holds no descriptor on its temp file", async () => {
    // the copy works on the temp PATH, so keeping tmp's descriptor open only creates
    // close bookkeeping; a stray close on a recycled descriptor number can hit an
    // unrelated file (observed: the parallel profile-sync copy's own temp)
    const src = path.join(dir, "src.txt");
    const dest = path.join(dir, "dest.txt");
    nodeFs.writeFileSync(src, "new content");

    await copyFileAtomic(src, dest);

    expect(tmpSpy.lastFileOpts).toMatchObject({ discardDescriptor: true });
  });

  it("keeps the destination intact when the source does not exist", async () => {
    const src = path.join(dir, "missing.txt");
    const dest = path.join(dir, "dest.txt");
    nodeFs.writeFileSync(dest, "old content");

    await expect(copyFileAtomic(src, dest)).rejects.toMatchObject({ code: "ENOENT" });

    expect(nodeFs.readFileSync(dest, "utf8")).toBe("old content");
    // the temp file must not linger next to the destination either
    expect(nodeFs.readdirSync(dir)).toEqual(["dest.txt"]);
  });
});
