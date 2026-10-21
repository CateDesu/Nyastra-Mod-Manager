import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./iniParser", () => ({ default: { getInstance: vi.fn() } }));
vi.mock("@nexusmods/vortex-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@nexusmods/vortex-api")>();
  return {
    ...original,
    fs: { ...original.fs, statAsync: stat },
    util: {
      ...original.util,
      getSafe: (value: any, keys: string[], fallback: any) =>
        keys.reduce((current, key) => current?.[key], value) ?? fallback,
    },
  };
});

import { log } from "@nexusmods/vortex-api";

import IniStructure from "./iniParser";
import { getManuallyAddedMods, walkPath } from "./util";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nyastra-witcher-walk-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("rejects a real filesystem walk failure instead of leaving deployment pending", async () => {
  const file = path.join(root, "not-a-directory");
  await writeFile(file, "keep me");
  await expect(walkPath(file)).rejects.toMatchObject({ code: "ENOTDIR" });
  expect(await readFile(file, "utf8")).toBe("keep me");
}, 1000);

it("tolerates a removed mod directory", async () => {
  expect(await walkPath(path.join(root, "missing"))).toEqual([]);
});

it("walks regular mod files without following symlinks", async () => {
  await mkdir(path.join(root, "content"));
  await writeFile(path.join(root, "content", "mod.ws"), "script");
  await symlink("content", path.join(root, "linked"));
  const entries = await walkPath(root);
  const files = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.filePath);
  expect(files).toContain(path.join(root, "content", "mod.ws"));
  expect(files).not.toContain(path.join(root, "linked", "mod.ws"));
});

it("logs an invalid manual mod folder and continues scanning other mods", async () => {
  await mkdir(path.join(root, "Mods", "modGood"), { recursive: true });
  await writeFile(path.join(root, "Mods", "modGood", "script.ws"), "script");
  await writeFile(path.join(root, "Mods", "modBroken"), "not a directory");
  vi.mocked(IniStructure.getInstance).mockReturnValue({
    ensureModSettings: async () => ({ data: { modBroken: {}, modGood: {}, modMissing: {} } }),
  } as unknown as IniStructure);
  const api = {
    getState: () => ({ settings: { gameMode: { discovered: { witcher3: { path: root } } } } }),
  } as any;
  expect(await getManuallyAddedMods(api)).toEqual(["modGood"]);
  expect(log).toHaveBeenCalledWith(
    "error",
    "unable to walk path",
    expect.objectContaining({ code: "ENOTDIR" }),
  );
}, 1000);
