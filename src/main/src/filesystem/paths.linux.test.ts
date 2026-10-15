import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { XDG } from "@vortex/shared/filesystem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LinuxPathProvider } from "./paths.linux";

afterEach(() => vi.unstubAllEnvs());

describe("Linux XDG paths", () => {
  it.each([
    [XDG.data, ".local/share"],
    [XDG.config, ".config"],
    [XDG.state, ".local/state"],
    [XDG.cache, ".cache"],
    [XDG.runtime, undefined],
  ] as const)("ignores a relative %s value", async (base, fallback) => {
    vi.stubEnv(base, "relative-directory");
    const result = await new LinuxPathProvider().fromBase(base);
    expect(result.path).toBe(fallback ? path.join(homedir(), fallback) : tmpdir());
  });

  it.each(Object.values(XDG))("honors an absolute %s value", async (base) => {
    vi.stubEnv(base, "/tmp/nyastra-xdg-test");
    expect((await new LinuxPathProvider().fromBase(base)).path).toBe("/tmp/nyastra-xdg-test");
  });
});
