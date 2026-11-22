import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

const child = path.join(__dirname, "iniBake.process.fixture.cjs");
const repo = path.resolve(__dirname, "../../../../..");
const require = createRequire(path.join(repo, "src/renderer/package.json"));
const babel = require("@babel/core");
const filename = path.join(__dirname, "index.ts");
const source = readFileSync(filename, "utf8");
const parsed = babel.parseSync(source, {
  configFile: false,
  babelrc: false,
  parserOpts: { plugins: ["typescript"] },
});
const names = [
  "completeSettingsOperations",
  "cleanupIniBake",
  "withIniBakeTemporary",
  "snapshotIni",
  "recoverIniBake",
  "publishIniBake",
  "genIniFormat",
  "missingOptionalFile",
  "getBaseFile",
  "bakeSettings",
  "purgeChanges",
];
const statements = parsed.program.body.filter(
  (node) => node.type === "FunctionDeclaration" && names.includes(node.id?.name),
);
expect(statements).toHaveLength(names.length);
const code = babel.transformSync(
  statements.map((node) => source.slice(node.start, node.end)).join("\n"),
  { filename, configFile: false, babelrc: false, presets: [require("@babel/preset-typescript")] },
).code;
const old = "[General]\nowner=old\n";
const base = "[General]\nowner=base\n";
const boundaries = [
  "marker-created",
  "marker-partial",
  "marker-published",
  "partial-staging",
  "before-replace",
  "after-replace",
  "live-unlink",
];

for (const operation of ["bake", "purge", "optional"]) {
  test.each(boundaries)(
    `recovers ${operation} after process exit at %s`,
    async (boundary) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "nyastra-ini-process-"));
      const directory = path.join(root, "game");
      await fs.mkdir(directory);
      const sourceFile = path.join(root, "production.js");
      await fs.writeFile(sourceFile, code);
      const file = path.join(directory, "Skyrim.ini");
      const sentinel = file + ".baked.12345678-1234-4234-8234-123456789abc.tmp";
      const run = (action: string, point = "none") =>
        spawnSync(process.execPath, [child, action, point, directory, sourceFile], {
          encoding: "utf8",
          env: { ...process.env, FORCE_COLOR: undefined },
          timeout: 10000,
        });
      try {
        if (operation !== "optional")
          for (const suffix of ["", ".baked", ".base"])
            await fs.writeFile(file + suffix, suffix === ".base" ? base : old, { mode: 0o640 });
        await fs.writeFile(sentinel, "unrelated file");
        const crashed = run(operation, boundary);
        expect(crashed.stderr).toBe("");
        if (boundary === "live-unlink") {
          expect(crashed.signal).toBeNull();
          expect(crashed.status).toBe(0);
        } else {
          expect(crashed.signal).toBe("SIGKILL");
          const live = await fs.readFile(file, "utf8").catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          });
          const candidate = await fs.readFile(file + ".baked", "utf8").catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          });
          expect([operation === "optional" ? null : old, candidate]).toContain(live);
        }
        for (let attempt = 0; attempt < 2; ++attempt) {
          const recovered = run("recover");
          expect(recovered.stderr).toBe("");
          expect(recovered.status).toBe(0);
          if (boundary !== "live-unlink") {
            if (operation === "optional") {
              await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
              await expect(fs.stat(file + ".baked")).rejects.toMatchObject({ code: "ENOENT" });
            } else {
              expect(await fs.readFile(file, "utf8")).toBe(old);
              expect(await fs.readFile(file + ".baked", "utf8")).toBe(old);
              expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
            }
          }
        }
        for (let attempt = 0; attempt < 2; ++attempt) {
          const baked = run(operation === "optional" ? "optional" : "bake");
          expect(baked.stderr).toBe("");
          expect(baked.status).toBe(0);
          expect(await fs.readFile(file, "utf8")).toContain("owner=new");
        }
        expect(await fs.readFile(file + ".base", "utf8")).toBe(
          operation === "optional" ? "" : base,
        );
        expect(await fs.readFile(sentinel, "utf8")).toBe("unrelated file");
        expect((await fs.readdir(directory)).sort()).toEqual(
          ["Skyrim.ini", "Skyrim.ini.baked", "Skyrim.ini.base", path.basename(sentinel)].sort(),
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );
}

test.each(["file", "foreign-entry", "symlink"])(
  "preserves an unrelated cleanup reservation: %s",
  async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nyastra-ini-reservation-"));
    const file = path.join(root, "Skyrim.ini");
    const reservation = file + ".baked.cleanup.init";
    const sourceFile = path.join(root, "production.js");
    try {
      await fs.writeFile(file, old);
      await fs.writeFile(sourceFile, code);
      let sentinel = reservation;
      if (mode === "file") await fs.writeFile(sentinel, "external");
      else {
        const directory = mode === "symlink" ? path.join(root, "external") : reservation;
        await fs.mkdir(directory);
        sentinel = path.join(directory, mode === "symlink" ? "owner" : "external");
        await fs.writeFile(sentinel, "external");
        if (mode === "symlink") await fs.symlink(directory, reservation);
      }
      const result = spawnSync(process.execPath, [child, "recover", "none", root, sourceFile], {
        encoding: "utf8",
        timeout: 10000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("INI cleanup reservation");
      expect(await fs.readFile(file, "utf8")).toBe(old);
      expect(await fs.readFile(sentinel, "utf8")).toBe("external");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
