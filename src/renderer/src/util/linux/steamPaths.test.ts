import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import getVortexPath from "../getVortexPath";
import { findAllLinuxSteamPaths, findLinuxSteamPath, isValidSteamPath } from "./steamPaths";

vi.mock("../getVortexPath", () => ({ default: vi.fn() }));
let home: string;
let data: string;
function install(directory: string): void {
  fs.mkdirSync(path.join(directory, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "config", "libraryfolders.vdf"),
    '"libraryfolders"\n{\n}\n',
  );
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-steam-"));
  data = path.join(home, "Custom Data");
  vi.mocked(getVortexPath).mockReturnValue(home);
  vi.stubEnv("XDG_DATA_HOME", data);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("Linux Steam root discovery", () => {
  it("finds custom XDG, Flatpak and Snap installations together", () => {
    const roots = [
      path.join(data, "Steam"),
      path.join(home, ".var/app/com.valvesoftware.Steam/data/Steam"),
      path.join(home, "snap/steam/common/.local/share/Steam"),
    ];
    roots.forEach(install);
    expect(findAllLinuxSteamPaths()).toEqual(roots);
  });

  it("prefers the existing Steam root link without rewriting it and removes duplicate roots", () => {
    const root = path.join(data, "Steam");
    install(root);
    fs.mkdirSync(path.join(home, ".steam"));
    fs.symlinkSync(root, path.join(home, ".steam/root"));
    fs.symlinkSync(root, path.join(home, ".steam/steam"));
    const before = fs.lstatSync(path.join(home, ".steam/root"));
    expect(findAllLinuxSteamPaths()).toEqual([root]);
    expect(findLinuxSteamPath()).toBe(root);
    expect(fs.lstatSync(path.join(home, ".steam/root")).ino).toBe(before.ino);
    expect(fs.readlinkSync(path.join(home, ".steam/root"))).toBe(root);
  });

  it("requires a manifest file and ignores broken root links", () => {
    const invalid = path.join(data, "Steam");
    fs.mkdirSync(path.join(invalid, "config/libraryfolders.vdf"), { recursive: true });
    fs.mkdirSync(path.join(home, ".steam"));
    fs.symlinkSync(path.join(home, "missing"), path.join(home, ".steam/root"));
    expect(isValidSteamPath(invalid)).toBe(false);
    expect(findAllLinuxSteamPaths()).toEqual([]);
    expect(findLinuxSteamPath()).toBeUndefined();
  });
});
