import * as nativeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as fs from "./fs";

let root: string;
let actual: string;
let requested: string;

beforeEach(() => {
  root = nativeFs.mkdtempSync(path.join(os.tmpdir(), "nyastra-wine-case-"));
  actual = path.join(
    root,
    "compatdata/42/pfx/drive_c/users/steamuser/AppData/Local/Game/Plugins.txt",
  );
  requested = path.join(
    root,
    "compatdata/42/pfx/drive_c/users/steamuser/appdata/local/game/plugins.txt",
  );
  nativeFs.mkdirSync(path.dirname(actual), { recursive: true });
  nativeFs.writeFileSync(actual, "original");
});

afterEach(() => nativeFs.rmSync(root, { recursive: true, force: true }));

describe("Wine prefix filename casing", () => {
  it("reads and stats a file through differently cased parent directories", async () => {
    await expect(fs.readFileAsync(requested, "utf8")).resolves.toBe("original");
    expect((await fs.statAsync(requested)).isFile()).toBe(true);
  });

  it("updates the existing file without creating a second filename", async () => {
    await fs.writeFileAsync(requested, "changed");
    expect(nativeFs.readFileSync(actual, "utf8")).toBe("changed");
    expect(nativeFs.readdirSync(path.dirname(actual))).toEqual(["Plugins.txt"]);
  });

  it("copies, renames and removes using the real source casing", async () => {
    const copy = path.join(root, "copy.txt");
    await fs.copyAsync(requested, copy);
    expect(nativeFs.readFileSync(copy, "utf8")).toBe("original");
    const renamed = path.join(path.dirname(actual), "renamed.txt");
    await fs.renameAsync(requested, renamed);
    await fs.unlinkAsync(path.join(path.dirname(requested), "RENAMED.TXT"));
    expect(nativeFs.existsSync(renamed)).toBe(false);
  });

  it("keeps ordinary Linux files case sensitive", async () => {
    nativeFs.writeFileSync(path.join(root, "Native.txt"), "native");
    await expect(fs.readFileAsync(path.join(root, "native.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
