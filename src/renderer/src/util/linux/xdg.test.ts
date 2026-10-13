import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { xdgDataHome, xdgConfigHome, xdgCacheHome, xdgStateHome } from "./xdg";

afterEach(() => vi.unstubAllEnvs());

describe.each([
  ["XDG_DATA_HOME", xdgDataHome, ".local/share"],
  ["XDG_CONFIG_HOME", xdgConfigHome, ".config"],
  ["XDG_CACHE_HOME", xdgCacheHome, ".cache"],
  ["XDG_STATE_HOME", xdgStateHome, ".local/state"],
] as const)("%s", (variable, resolve, fallback) => {
  it("uses an absolute override", () => {
    vi.stubEnv(variable, "/custom/xdg");
    expect(resolve()).toBe("/custom/xdg");
  });
  it("ignores relative and empty overrides", () => {
    for (const value of ["relative/path", ""]) {
      vi.stubEnv(variable, value);
      expect(resolve()).toBe(path.join(os.homedir(), fallback));
    }
  });
});
