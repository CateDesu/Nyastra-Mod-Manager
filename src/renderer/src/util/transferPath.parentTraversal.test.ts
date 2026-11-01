import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Zip from "node-7z";
import { afterEach, expect, test, vi } from "vitest";

import * as programFs from "./fs";
import { transferPath } from "./transferPath";
afterEach(() => vi.restoreAllMocks());

for (const route of ["hardlink", "fallback", "cross-volume"] as const) {
  test(`${route}: a parent segment following a directory symlink retains native target meaning`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "round3-symlink-parent-"));
    const other = route === "cross-volume" ? fs.mkdtempSync("/dev/shm/nyastra-parent-") : root;
    const source = path.join(root, "old");
    const dest = path.join(other, "deeper", "new");
    const external = path.join(root, "external");
    fs.mkdirSync(path.join(source, "game"), { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.mkdirSync(path.join(external, "child"), { recursive: true });
    const input = path.join(root, "payload.txt");
    fs.writeFileSync(input, "different internal archive");
    await new Zip().add(path.join(source, "game", "archive.zip"), [input]);
    fs.writeFileSync(input, "intended external archive");
    await new Zip().add(path.join(external, "archive.zip"), [input]);
    const externalBytes = fs.readFileSync(path.join(external, "archive.zip"));
    fs.symlinkSync(path.join(external, "child"), path.join(source, "game", "jump"));
    fs.symlinkSync("jump/../archive.zip", path.join(source, "game", "alias.zip"));
    try {
      expect(fs.readFileSync(path.join(source, "game", "alias.zip"))).toEqual(externalBytes);
      if (route === "fallback")
        vi.spyOn(programFs, "linkAsync").mockRejectedValue(
          Object.assign(new Error("copy required"), { code: "EXDEV" }),
        );
      expect(fs.statSync(source).dev === fs.statSync(dest).dev).toBe(route !== "cross-volume");
      await transferPath(source, dest, () => {});
      const alias = path.join(dest, "game", "alias.zip");
      expect(fs.existsSync(source)).toBe(false);
      expect(fs.readFileSync(alias)).toEqual(externalBytes);
      const extracted = path.join(root, "extracted");
      await new Zip().extractFull(alias, extracted);
      const actual = fs.readFileSync(path.join(extracted, "payload.txt"), "utf8");
      expect(actual).toBe("intended external archive");
      expect(fs.readFileSync(path.join(external, "archive.zip"))).toEqual(externalBytes);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      if (other !== root) fs.rmSync(other, { recursive: true, force: true });
    }
  });
}

test("root targets and unresolved parent traversal retain native meaning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-link-components-"));
  const source = path.join(root, "source"),
    dest = path.join(root, "deeper", "dest");
  const external = path.join(root, "external");
  fs.mkdirSync(path.join(source, "game"), { recursive: true });
  fs.mkdirSync(path.join(external, "child"), { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(source, "game", "archive.zip"), "internal archive");
  fs.symlinkSync(path.join(external, "child"), path.join(source, "game", "jump"));
  const links = {
    "external-dangling.zip": "jump/../missing.zip",
    "internal-dangling.zip": "missing/../archive.zip",
    "not-a-directory.zip": "archive.zip/../missing.zip",
    "root-link": source,
  };
  for (const [name, target] of Object.entries(links))
    fs.symlinkSync(target, path.join(source, "game", name));
  try {
    for (const name of Object.keys(links).filter((name) => name.endsWith(".zip")))
      expect(() => fs.readFileSync(path.join(source, "game", name))).toThrow();
    await transferPath(source, dest, () => {});
    expect(fs.existsSync(source)).toBe(false);
    for (const name of Object.keys(links))
      expect(fs.lstatSync(path.join(dest, "game", name)).isSymbolicLink()).toBe(true);
    for (const name of Object.keys(links).filter((name) => name.endsWith(".zip")))
      expect(() => fs.readFileSync(path.join(dest, "game", name))).toThrow();
    expect(fs.realpathSync(path.join(dest, "game", "root-link"))).toBe(dest);
    const externalLink = path.join(dest, "game", "external-dangling.zip");
    expect(path.resolve(path.dirname(externalLink), fs.readlinkSync(externalLink))).toBe(
      path.join(external, "missing.zip"),
    );
    expect(fs.readlinkSync(path.join(dest, "game", "internal-dangling.zip"))).toContain(
      "missing/../archive.zip",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
