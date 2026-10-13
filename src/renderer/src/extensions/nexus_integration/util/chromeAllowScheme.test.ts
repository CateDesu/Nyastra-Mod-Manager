import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTempDir } from "../../../test-utils/tempDir";
import getVortexPath from "../../../util/getVortexPath";
import chromeAllowScheme from "./chromeAllowScheme";

vi.mock("../../../util/getVortexPath", () => ({ default: vi.fn() }));
vi.mock("../../../util/log", () => ({ log: vi.fn() }));
vi.mock("../../../util/fs", async () => {
  const nativeFs = await import("node:fs/promises");
  return {
    readFileAsync: nativeFs.readFile,
    writeFileAsync: nativeFs.writeFile,
    unlinkAsync: nativeFs.unlink,
    renameAsync: nativeFs.rename,
  };
});

let userData: string;

function writeFixture(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(value));
}

beforeEach(async () => {
  const root = await makeTempDir("vortex-chrome-");
  vi.mocked(getVortexPath).mockReturnValue(root);
  vi.stubEnv("LOCALAPPDATA", root);
  userData = path.join(root, "google-chrome");
});

afterEach(() => vi.unstubAllEnvs());

describe("Chrome download-link repair", () => {
  it("repairs the selected profile while preserving Local State", async () => {
    const localState = path.join(userData, "Local State");
    const preferences = path.join(userData, "Profile 1", "Preferences");
    writeFixture(localState, { profile: { last_used: "Profile 1" } });
    writeFixture(preferences, {
      protocol_handler: { excluded_schemes: { nxm: true, other: true } },
    });
    const before = fs.readFileSync(localState);

    await expect(chromeAllowScheme("nxm")).resolves.toBe(true);

    expect(JSON.parse(fs.readFileSync(preferences, "utf8"))).toEqual({
      protocol_handler: { excluded_schemes: { nxm: false, other: true } },
    });
    expect(fs.readFileSync(localState).equals(before)).toBe(true);
  });

  it("uses the default profile when Local State is absent", async () => {
    const preferences = path.join(userData, "Default", "Preferences");
    writeFixture(preferences, { protocol_handler: { excluded_schemes: { nxm: true } } });

    await expect(chromeAllowScheme("nxm")).resolves.toBe(true);

    expect(JSON.parse(fs.readFileSync(preferences, "utf8"))).toEqual({
      protocol_handler: { excluded_schemes: { nxm: false } },
    });
  });

  it("leaves modern preferences untouched when the legacy setting is absent", async () => {
    const preferences = path.join(userData, "Default", "Preferences");
    writeFixture(path.join(userData, "Local State"), { profile: { last_used: "Default" } });
    writeFixture(preferences, {
      protocol_handler: {
        allowed_origin_protocol_pairs: { "https://www.nexusmods.com": { nxm: true } },
      },
    });
    const before = fs.readFileSync(preferences);

    await expect(chromeAllowScheme("nxm")).resolves.toBe(false);

    expect(fs.readFileSync(preferences).equals(before)).toBe(true);
  });

  it("leaves an already allowed legacy scheme unchanged", async () => {
    const preferences = path.join(userData, "Default", "Preferences");
    writeFixture(path.join(userData, "Local State"), { profile: { last_used: "Default" } });
    writeFixture(preferences, { protocol_handler: { excluded_schemes: { nxm: false } } });
    const before = fs.readFileSync(preferences);

    await expect(chromeAllowScheme("nxm")).resolves.toBe(false);

    expect(fs.readFileSync(preferences).equals(before)).toBe(true);
  });
});
