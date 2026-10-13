import { spawnSync } from "child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applicationsDirectory, refreshDesktopDatabase } from "./common";
vi.mock("child_process", () => {
  const api = { spawnSync: vi.fn() };
  return { ...api, default: api };
});
vi.mock("../../log", () => ({ log: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
});
afterEach(() => vi.unstubAllEnvs());
describe("Linux desktop cache updates", () => {
  it("refreshes KDE 6 after the MIME cache", () => {
    vi.stubEnv("XDG_CURRENT_DESKTOP", "KDE");
    refreshDesktopDatabase("/test/applications");
    expect(vi.mocked(spawnSync).mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["update-desktop-database", ["/test/applications"]],
      ["kbuildsycoca6", ["--noincremental"]],
    ]);
  });
  it("falls back to KDE 5 when KDE 6 is unavailable", () => {
    vi.stubEnv("XDG_CURRENT_DESKTOP", "KDE");
    vi.mocked(spawnSync).mockImplementation(
      (command) =>
        ({
          status: command === "kbuildsycoca6" ? null : 0,
          stdout: "",
          stderr: "",
          error:
            command === "kbuildsycoca6"
              ? Object.assign(new Error("missing"), { code: "ENOENT" })
              : undefined,
        }) as never,
    );
    refreshDesktopDatabase("/test/applications");
    expect(vi.mocked(spawnSync).mock.calls.at(-1)?.[0]).toBe("kbuildsycoca5");
  });
  it("does not run KDE commands on another desktop", () => {
    vi.stubEnv("XDG_CURRENT_DESKTOP", "GNOME");
    refreshDesktopDatabase("/test/applications");
    expect(spawnSync).toHaveBeenCalledOnce();
  });
  it("ignores relative XDG paths", () => {
    vi.stubEnv("XDG_DATA_HOME", "relative");
    expect(applicationsDirectory()).toMatch(/^\//);
  });
});
