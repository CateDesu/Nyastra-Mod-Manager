import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { purgeDeployedFiles } from "./activationStore";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-manifest-purge-"));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

it("purges the manifest's target directory and preserves a same-named root file", async () => {
  fs.mkdirSync(path.join(directory, "mod"));
  const deployed = path.join(directory, "mod", "config.ini");
  const original = path.join(directory, "config.ini");
  fs.writeFileSync(deployed, "modded");
  fs.writeFileSync(original, "original");
  fs.utimesSync(deployed, 1_000, 1_000);
  fs.utimesSync(original, 1_000, 1_000);

  await purgeDeployedFiles(directory, [
    {
      relPath: "config.ini",
      target: "mod",
      source: "SomeMod",
      time: 1_000_000,
    },
  ]);

  expect(fs.readFileSync(original, "utf8")).toBe("original");
  expect(fs.existsSync(deployed)).toBe(false);
});

it.each([900, 1_100])(
  "preserves a replaced file with timestamp %s when the manifest records 1000",
  async (mtime) => {
    const filename = path.join(directory, "config.ini");
    fs.writeFileSync(filename, "external replacement");
    fs.utimesSync(filename, mtime, mtime);

    await purgeDeployedFiles(directory, [
      {
        relPath: "config.ini",
        source: "SomeMod",
        time: 1_000_000,
      },
    ]);

    expect(fs.readFileSync(filename, "utf8")).toBe("external replacement");
  },
);

it("accepts subsecond timestamp rounding and tolerates files already missing", async () => {
  const filename = path.join(directory, "config.ini");
  fs.writeFileSync(filename, "modded");
  fs.utimesSync(filename, 1_000, 1_000.5);
  await purgeDeployedFiles(
    directory,
    ["config.ini", "missing.ini"].map((relPath) => ({
      relPath,
      source: "SomeMod",
      time: 1_000_000,
    })),
  );
  expect(fs.existsSync(filename)).toBe(false);
});
