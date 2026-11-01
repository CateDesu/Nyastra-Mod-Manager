import * as fs from "node:fs";
import * as native from "node:fs/promises";
import type * as nodePromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof nodePromises>();
  const mocked = {
    ...actual,
    link: vi.fn(actual.link),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
    copyFile: vi.fn(actual.copyFile),
    utimes: vi.fn(actual.utimes),
  };
  return { ...mocked, default: mocked };
});

import { UserCanceled } from "./CustomErrors";
import { moveFileNoReplace } from "./fsAtomic";

const failure = (code: string) => Object.assign(new Error(`fixture ${code}`), { code });

describe("moveFileNoReplace", () => {
  let directory: string;
  let source: string;
  let destination: string;

  beforeEach(() => {
    vi.resetAllMocks();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-exclusive-move-"));
    source = path.join(directory, "source");
    destination = path.join(directory, "destination");
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("moves the inode with permissions and modification time", async () => {
    fs.writeFileSync(source, "original", { mode: 0o750 });
    fs.utimesSync(source, 1000, 2000);
    const inode = fs.statSync(source).ino;
    await moveFileNoReplace(source, destination);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(destination, "utf8")).toBe("original");
    expect(fs.statSync(destination).ino).toBe(inode);
    expect(fs.statSync(destination).mode & 0o777).toBe(0o750);
    expect(fs.statSync(destination).mtimeMs).toBe(2000000);
    expect(fs.readdirSync(directory)).toEqual(["destination"]);
  });

  it.each(["before claim", "after claim", "after publication"])(
    "preserves replacements %s",
    async (when) => {
      fs.writeFileSync(source, "original");
      const replace = () => {
        fs.writeFileSync(source + ".replacement", "newer");
        fs.renameSync(source + ".replacement", source);
      };
      const rename = vi.mocked(native.rename).getMockImplementation()!;
      vi.mocked(native.rename).mockImplementation(async (from, to) => {
        if (from === source && when === "before claim") replace();
        await rename(from, to);
        if (from === source && when === "after claim") replace();
      });
      const link = vi.mocked(native.link).getMockImplementation()!;
      vi.mocked(native.link).mockImplementation(async (from, to) => {
        await link(from, to);
        if (to === destination && when === "after publication") replace();
      });
      await moveFileNoReplace(source, destination);
      expect(fs.readFileSync(destination, "utf8")).toBe(
        when === "before claim" ? "newer" : "original",
      );
      expect(fs.existsSync(source)).toBe(when !== "before claim");
      if (when !== "before claim") expect(fs.readFileSync(source, "utf8")).toBe("newer");
    },
  );

  it("keeps open writers attached to the destination", async () => {
    fs.writeFileSync(source, "original");
    const fd = fs.openSync(source, "r+");
    try {
      await moveFileNoReplace(source, destination);
      fs.writeSync(fd, "updated!", 0, "utf8");
      expect(fs.readFileSync(destination, "utf8")).toBe("updated!");
      expect(fs.existsSync(source)).toBe(false);
    } finally {
      fs.closeSync(fd);
    }
  });

  for (const fallback of [false, true]) {
    describe(fallback ? "copy fallback" : "hardlink publication", () => {
      beforeEach(() => {
        if (fallback) vi.mocked(native.link).mockRejectedValueOnce(failure("EXDEV"));
      });
      it.each(["file", "dangling symlink", "directory"])(
        "refuses an occupied %s destination",
        async (kind) => {
          fs.writeFileSync(source, "original");
          if (kind === "file") fs.writeFileSync(destination, "external");
          if (kind === "dangling symlink") fs.symlinkSync("missing", destination);
          if (kind === "directory") fs.mkdirSync(destination);
          await expect(moveFileNoReplace(source, destination)).rejects.toMatchObject({
            code: "EEXIST",
          });
          expect(fs.readFileSync(source, "utf8")).toBe("original");
          if (kind === "file") expect(fs.readFileSync(destination, "utf8")).toBe("external");
          if (kind === "dangling symlink") expect(fs.readlinkSync(destination)).toBe("missing");
          if (kind === "directory") expect(fs.statSync(destination).isDirectory()).toBe(true);
        },
      );
    });
  }

  it("allows only one concurrent move to publish", async () => {
    const other = path.join(directory, "other");
    fs.writeFileSync(source, "first");
    fs.writeFileSync(other, "second");
    const results = await Promise.allSettled([
      moveFileNoReplace(source, destination),
      moveFileNoReplace(other, destination),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results[0].status === "fulfilled" ? "first" : "second";
    expect(fs.readFileSync(destination, "utf8")).toBe(winner);
    expect(fs.readFileSync(winner === "first" ? other : source, "utf8")).toBe(
      winner === "first" ? "second" : "first",
    );
  });

  it.each(["EXDEV", "EOPNOTSUPP", "EPERM"])(
    "retains an open source and reports %s copy fallback",
    async (code) => {
      fs.writeFileSync(source, "original", { mode: 0o750 });
      fs.utimesSync(source, 1000, 2000);
      const fd = fs.openSync(source, "r+");
      vi.mocked(native.link).mockRejectedValueOnce(failure(code));
      try {
        await expect(moveFileNoReplace(source, destination)).rejects.toMatchObject({
          code: "EBUSY",
          recoveryPath: source,
        });
        fs.writeSync(fd, "updated!", 0, "utf8");
        expect(fs.readFileSync(source, "utf8")).toBe("updated!");
        expect(fs.readFileSync(destination, "utf8")).toBe("original");
        expect(fs.statSync(destination).mode & 0o777).toBe(0o750);
        expect(fs.statSync(destination).mtimeMs).toBe(2000000);
      } finally {
        fs.closeSync(fd);
      }
    },
  );

  it.each(["link", "copyFile", "utimes", "unlink"])(
    "retains the source after %s failure",
    async (operation) => {
      fs.writeFileSync(source, "original");
      if (operation === "copyFile" || operation === "utimes")
        vi.mocked(native.link).mockRejectedValueOnce(failure("EXDEV"));
      vi.mocked(native[operation]).mockRejectedValueOnce(failure("EIO"));
      await expect(moveFileNoReplace(source, destination)).rejects.toMatchObject({
        code: "EIO",
        recoveryPath: source,
      });
      expect(fs.readFileSync(source, "utf8")).toBe("original");
      if (operation === "utimes" || operation === "unlink")
        expect(fs.readFileSync(destination, "utf8")).toBe("original");
    },
  );

  it("retains private recovery bytes when a recreated source prevents rollback", async () => {
    fs.writeFileSync(source, "original");
    const link = vi.mocked(native.link).getMockImplementation()!;
    vi.mocked(native.link).mockImplementation(async (from, to) => {
      if (to === destination) {
        fs.writeFileSync(source, "newer");
        throw failure("EACCES");
      }
      await link(from, to);
    });
    const error = (await moveFileNoReplace(source, destination).catch(
      (err) => err,
    )) as NodeJS.ErrnoException & { recoveryPath: string };
    expect(error.code).toBe("EACCES");
    expect(fs.readFileSync(error.recoveryPath, "utf8")).toBe("original");
    expect(fs.readFileSync(source, "utf8")).toBe("newer");
  });

  it("preserves cancellation identity and the owned source", async () => {
    fs.writeFileSync(source, "original");
    const cancelled = new UserCanceled();
    vi.mocked(native.link).mockRejectedValueOnce(cancelled);
    await expect(moveFileNoReplace(source, destination)).rejects.toBe(cancelled);
    expect(fs.readFileSync(source, "utf8")).toBe("original");
  });

  it("retains sources after a partial copy failure", async () => {
    fs.writeFileSync(source, "original");
    vi.mocked(native.link).mockRejectedValueOnce(failure("EXDEV"));
    vi.mocked(native.copyFile).mockImplementationOnce(async (_from, to) => {
      fs.writeFileSync(to, "partial");
      throw failure("EIO");
    });
    await expect(moveFileNoReplace(source, destination)).rejects.toMatchObject({
      code: "EIO",
      recoveryPath: source,
    });
    expect(fs.readFileSync(source, "utf8")).toBe("original");
    expect(fs.readFileSync(destination, "utf8")).toBe("partial");
  });

  it("retains both source names when retirement and rollback cleanup fail", async () => {
    fs.writeFileSync(source, "original");
    vi.mocked(native.unlink).mockRejectedValue(failure("EACCES"));
    await expect(moveFileNoReplace(source, destination)).rejects.toMatchObject({
      code: "EACCES",
      recoveryPath: source,
    });
    expect(fs.readFileSync(source, "utf8")).toBe("original");
    expect(fs.readFileSync(destination, "utf8")).toBe("original");
    const holding = fs
      .readdirSync(directory)
      .find((name) => name.startsWith(".nyastra-file-move-"))!;
    expect(fs.readFileSync(path.join(directory, holding, "source"), "utf8")).toBe("original");
  });

  it.skipIf(fs.statSync(os.tmpdir()).dev === fs.statSync("/dev/shm").dev)(
    "keeps a recoverable source across devices",
    async () => {
      const remote = fs.mkdtempSync("/dev/shm/nyastra-owned-move-");
      fs.writeFileSync(source, "original");
      try {
        const dest = path.join(remote, "destination");
        await expect(moveFileNoReplace(source, dest)).rejects.toMatchObject({
          code: "EBUSY",
          recoveryPath: source,
        });
        expect(fs.readFileSync(source, "utf8")).toBe("original");
        expect(fs.readFileSync(dest, "utf8")).toBe("original");
      } finally {
        fs.rmSync(remote, { recursive: true, force: true });
      }
    },
  );

  it("keeps private recovery when hardlinks are entirely unsupported", async () => {
    fs.writeFileSync(source, "original");
    vi.mocked(native.link).mockRejectedValue(failure("EPERM"));
    const error = (await moveFileNoReplace(source, destination).catch(
      (err) => err,
    )) as NodeJS.ErrnoException & { recoveryPath: string };
    expect(error.code).toBe("EBUSY");
    expect(fs.readFileSync(error.recoveryPath, "utf8")).toBe("original");
    expect(fs.readFileSync(destination, "utf8")).toBe("original");
  });

  it("does not disguise a missing destination parent as a missing source", async () => {
    fs.writeFileSync(source, "original");
    await expect(
      moveFileNoReplace(source, path.join(directory, "missing/dest")),
    ).rejects.toMatchObject({ code: "EIO", recoveryPath: source });
    expect(fs.readFileSync(source, "utf8")).toBe("original");
  });

  it("rejects missing sources without creating a destination", async () => {
    await expect(moveFileNoReplace(source, destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("retains nonregular sources for recovery", async () => {
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "payload"), "original");
    const error = (await moveFileNoReplace(source, destination).catch(
      (err) => err,
    )) as NodeJS.ErrnoException & { recoveryPath: string };
    expect(error.code).toBe("EINVAL");
    expect(fs.readFileSync(path.join(error.recoveryPath, "payload"), "utf8")).toBe("original");
  });

  it.each(["missing", "payload", "jump/../payload"])(
    "preserves relative symlink traversal for %s",
    async (target) => {
      const output = path.join(directory, "deeper");
      fs.mkdirSync(output);
      const external = path.join(directory, "external");
      fs.mkdirSync(external);
      fs.mkdirSync(path.join(external, "child"));
      fs.writeFileSync(path.join(external, "payload"), "external");
      fs.writeFileSync(path.join(directory, "payload"), "internal");
      fs.symlinkSync(path.join(external, "child"), path.join(directory, "jump"));
      fs.symlinkSync(target, source);
      const expected = target === "missing" ? undefined : fs.readFileSync(source, "utf8");
      const dest = path.join(output, "link");
      await moveFileNoReplace(source, dest);
      expect(fs.lstatSync(source, { throwIfNoEntry: false })).toBeUndefined();
      expect(path.isAbsolute(fs.readlinkSync(dest))).toBe(false);
      if (expected !== undefined) expect(fs.readFileSync(dest, "utf8")).toBe(expected);
      else expect(fs.existsSync(dest)).toBe(false);
    },
  );
});
