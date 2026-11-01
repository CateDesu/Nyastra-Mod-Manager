import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import PromiseBB from "bluebird";
import Zip from "node-7z";
import { afterEach, expect, test, vi } from "vitest";

import { UserCanceled } from "./CustomErrors";
import * as programFs from "./fs";
import { cleanFailedTransfer, transferPath } from "./transferPath";

afterEach(() => vi.restoreAllMocks());

for (const route of ["hardlink", "fallback", "cross-volume"] as const) {
  for (const depth of ["deeper", "shallower"] as const) {
    test(`folder transfer preserves native link targets: ${route}, ${depth}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-links-"));
      const other = route === "cross-volume" ? fs.mkdtempSync("/dev/shm/nyastra-links-") : root;
      const source = path.join(root, ...(depth === "deeper" ? [] : ["old", "deep"]), "downloads");
      const dest = path.join(other, ...(depth === "deeper" ? ["new", "deep"] : []), "moved");
      const external = path.join(root, "external");
      fs.mkdirSync(path.join(source, "game"), { recursive: true });
      fs.mkdirSync(external);
      fs.mkdirSync(dest, { recursive: true });
      const payload = path.join(external, "payload.txt");
      fs.writeFileSync(payload, "disposable external archive");
      const archive = path.join(external, "archive.zip");
      await new Zip().add(archive, [payload]);
      const original = fs.readFileSync(archive);
      fs.copyFileSync(archive, path.join(source, "game", "internal.zip"));
      const links: Record<string, string> = {
        "external-relative.zip": path.relative(path.join(source, "game"), archive),
        "external-absolute.zip": archive,
        "internal-relative.zip": "internal.zip",
        "internal-absolute.zip": path.join(source, "game", "internal.zip"),
        "chain.zip": "internal-absolute.zip",
        "external-chain.zip": "external-relative.zip",
        "dangling-internal.zip": "missing.zip",
        "dangling-external.zip": path.relative(
          path.join(source, "game"),
          path.join(external, "missing.zip"),
        ),
        directory: external,
      };
      for (const [name, target] of Object.entries(links))
        fs.symlinkSync(target, path.join(source, "game", name));
      if (route === "fallback")
        vi.spyOn(programFs, "linkAsync").mockRejectedValue(
          Object.assign(new Error("copy required"), { code: "EXDEV" }),
        );
      expect(fs.statSync(source).dev === fs.statSync(dest).dev).toBe(route !== "cross-volume");
      try {
        await transferPath(source, dest, () => {});
        expect(fs.existsSync(source)).toBe(false);
        for (const name of Object.keys(links)) {
          const moved = path.join(dest, "game", name);
          expect(fs.lstatSync(moved).isSymbolicLink()).toBe(true);
          if (name.startsWith("dangling")) {
            expect(fs.existsSync(moved)).toBe(false);
            const expected =
              name === "dangling-internal.zip"
                ? path.join(dest, "game", "missing.zip")
                : path.join(external, "missing.zip");
            expect(path.resolve(path.dirname(moved), fs.readlinkSync(moved))).toBe(expected);
          } else if (name === "directory") {
            expect(fs.readFileSync(path.join(moved, "archive.zip"))).toEqual(original);
          } else {
            expect(fs.readFileSync(moved)).toEqual(original);
          }
        }
        expect(fs.readFileSync(archive)).toEqual(original);
        const extracted = path.join(root, "extracted");
        await new Zip().extractFull(path.join(dest, "game", "external-relative.zip"), extracted);
        expect(fs.readFileSync(path.join(extracted, "payload.txt"), "utf8")).toBe(
          "disposable external archive",
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        if (other !== root) fs.rmSync(other, { recursive: true, force: true });
      }
    });
  }
}

for (const collision of ["file", "dangling-link"]) {
  test(`a source symlink never replaces a destination ${collision}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-link-collision-"));
    const source = path.join(root, "source"),
      dest = path.join(root, "dest");
    fs.mkdirSync(source);
    fs.mkdirSync(dest);
    const target = path.join(root, "archive.zip");
    fs.writeFileSync(target, "external bytes");
    fs.symlinkSync(target, path.join(source, "alias.zip"));
    if (collision === "file") fs.writeFileSync(path.join(dest, "alias.zip"), "previous bytes");
    else fs.symlinkSync("absent.zip", path.join(dest, "alias.zip"));
    try {
      await expect(transferPath(source, dest, () => {})).rejects.toMatchObject({ code: "EEXIST" });
      expect(fs.readFileSync(path.join(source, "alias.zip"), "utf8")).toBe("external bytes");
      if (collision === "file")
        expect(fs.readFileSync(path.join(dest, "alias.zip"), "utf8")).toBe("previous bytes");
      else expect(fs.readlinkSync(path.join(dest, "alias.zip"))).toBe("absent.zip");
      expect(fs.readFileSync(target, "utf8")).toBe("external bytes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("rollback removes copied links without traversing external directories", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-link-rollback-"));
  const source = path.join(root, "source"),
    dest = path.join(root, "dest"),
    external = path.join(root, "external");
  for (const folder of [source, dest, external]) fs.mkdirSync(folder);
  fs.writeFileSync(path.join(external, "payload.zip"), "external archive bytes");
  fs.symlinkSync(external, path.join(source, "directory"));
  fs.symlinkSync(path.join(external, "payload.zip"), path.join(source, "file.zip"));
  try {
    await expect(
      transferPath(
        source,
        dest,
        () => {},
        async () => {
          throw new UserCanceled();
        },
      ),
    ).rejects.toBeInstanceOf(UserCanceled);
    await cleanFailedTransfer(dest);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.readFileSync(path.join(external, "payload.zip"), "utf8")).toBe(
      "external archive bytes",
    );
    expect(fs.readFileSync(path.join(source, "directory", "payload.zip"), "utf8")).toBe(
      "external archive bytes",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("links keep their targets when the selected roots use directory aliases", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-root-links-"));
  const original = path.join(root, "physical", "old"),
    moved = path.join(root, "physical", "deep", "new");
  const source = path.join(root, "old-alias"),
    dest = path.join(root, "new-alias");
  const external = path.join(root, "physical", "external.zip");
  fs.mkdirSync(path.join(original, "game"), { recursive: true });
  fs.mkdirSync(moved, { recursive: true });
  fs.symlinkSync(original, source);
  fs.symlinkSync(moved, dest);
  fs.writeFileSync(external, "external payload");
  fs.writeFileSync(path.join(original, "game", "internal.zip"), "internal payload");
  fs.symlinkSync("../../external.zip", path.join(original, "game", "external.zip"));
  fs.symlinkSync(
    path.join(original, "game", "internal.zip"),
    path.join(original, "game", "internal-alias.zip"),
  );
  try {
    await transferPath(source, dest, () => {});
    fs.rmSync(original, { recursive: true });
    expect(fs.readFileSync(path.join(dest, "game", "external.zip"), "utf8")).toBe(
      "external payload",
    );
    expect(fs.readFileSync(path.join(dest, "game", "internal-alias.zip"), "utf8")).toBe(
      "internal payload",
    );
    expect(fs.readFileSync(external, "utf8")).toBe("external payload");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
