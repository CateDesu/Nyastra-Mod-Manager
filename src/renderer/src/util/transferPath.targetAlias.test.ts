import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import * as programFs from "./fs";
import { transferPath } from "./transferPath";

afterEach(() => vi.restoreAllMocks());

for (const route of ["hardlink", "fallback", "cross-volume"] as const)
  for (const alias of [false, true])
    test(`an internal archive reached through another directory alias remains readable: ${alias}, ${route}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "target-alias-"));
      const other =
        route === "cross-volume" ? fs.mkdtempSync("/dev/shm/nyastra-target-alias-") : root;
      const source = path.join(root, "downloads"),
        dest = path.join(other, "deeper", "downloads");
      fs.mkdirSync(path.join(source, "game"), { recursive: true });
      fs.mkdirSync(dest, { recursive: true });
      const old = path.join(source, "game", "payload.zip");
      fs.writeFileSync(old, "synthetic archive bytes");
      fs.symlinkSync(source, path.join(root, "library-alias"), "dir");
      fs.symlinkSync("payload.zip", path.join(source, "game", "leaf.zip"));
      const link = path.join(source, "game", "link.zip");
      fs.symlinkSync(alias ? "../../library-alias/game/leaf.zip" : "payload.zip", link);
      expect(fs.readFileSync(link, "utf8")).toBe("synthetic archive bytes");
      try {
        if (route === "fallback")
          vi.spyOn(programFs, "linkAsync").mockRejectedValue(
            Object.assign(new Error("copy required"), { code: "EXDEV" }),
          );
        expect(fs.statSync(source).dev === fs.statSync(dest).dev).toBe(route !== "cross-volume");
        await transferPath(source, dest, () => undefined);
        expect(fs.existsSync(source)).toBe(false);
        const moved = path.join(dest, "game", "link.zip");
        const bytes = (() => {
          try {
            return fs.readFileSync(moved, "utf8");
          } catch (e) {
            return (e as NodeJS.ErrnoException).code;
          }
        })();
        expect(path.basename(fs.readlinkSync(moved))).toBe(alias ? "leaf.zip" : "payload.zip");
        expect(fs.lstatSync(path.join(dest, "game", "leaf.zip")).isSymbolicLink()).toBe(true);
        expect(bytes).toBe("synthetic archive bytes");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        if (other !== root) fs.rmSync(other, { recursive: true, force: true });
      }
    });
