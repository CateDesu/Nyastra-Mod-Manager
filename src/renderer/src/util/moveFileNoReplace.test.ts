import * as fs from "node:fs";
import { link, unlink } from "node:fs/promises";
import type * as nodePromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof nodePromises>();
  const mocked = { ...actual, link: vi.fn(actual.link), unlink: vi.fn(actual.unlink) };
  return { ...mocked, default: mocked };
});

import { moveFileNoReplace } from "./fsAtomic";

describe("moveFileNoReplace", () => {
  let directory: string;
  let source: string;
  let destination: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-exclusive-move-"));
    source = path.join(directory, "source");
    destination = path.join(directory, "destination");
  });

  afterEach(() => {
    vi.mocked(link).mockReset();
    vi.mocked(unlink).mockReset();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  for (const fallback of [false, true]) {
    describe(fallback ? "without hardlink support" : "with hardlink support", () => {
      beforeEach(() => {
        if (fallback) {
          vi.mocked(link).mockRejectedValue(
            Object.assign(new Error("unsupported"), { code: "EOPNOTSUPP" }),
          );
        }
      });

      it("moves the bytes and preserves file permissions and modification time", async () => {
        fs.writeFileSync(source, "original", { mode: 0o750 });
        fs.utimesSync(source, 1_000, 2_000);
        await moveFileNoReplace(source, destination);
        expect(fs.existsSync(source)).toBe(false);
        expect(fs.readFileSync(destination, "utf8")).toBe("original");
        expect(fs.statSync(destination).mode & 0o777).toBe(0o750);
        expect(fs.statSync(destination).mtimeMs).toBe(2_000_000);
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

      it("moves a dangling symlink without following its target", async () => {
        fs.symlinkSync("missing", source);
        await moveFileNoReplace(source, destination);
        expect(fs.existsSync(source)).toBe(false);
        expect(fs.readlinkSync(destination)).toBe("missing");
      });

      it("allows only one concurrent move to claim a destination", async () => {
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
    });
  }

  it("retains both copies when removing the source fails", async () => {
    fs.writeFileSync(source, "original");
    vi.mocked(unlink).mockRejectedValueOnce(
      Object.assign(new Error("storage failure"), { code: "EIO" }),
    );
    await expect(moveFileNoReplace(source, destination)).rejects.toMatchObject({ code: "EIO" });
    expect(fs.readFileSync(source, "utf8")).toBe("original");
    expect(fs.readFileSync(destination, "utf8")).toBe("original");
  });
});
