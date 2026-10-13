import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  lstat: vi.fn(),
  readdir: vi.fn(),
  statfs: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock("node:child_process", () => {
  const api = {
    execFile: (...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      mocks.execute(...args.slice(0, -1));
      callback(null, "", "");
    },
  };
  return { ...api, default: api };
});
vi.mock("node:fs/promises", () => {
  const api = {
    lstat: mocks.lstat,
    readdir: mocks.readdir,
    statfs: mocks.statfs,
    stat: mocks.stat,
    writeFile: mocks.writeFile,
    unlink: mocks.unlink,
  };
  return { ...api, default: api };
});
import { enableDirectoryCasefold } from "./casefold";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FLATPAK_ID", "");
  mocks.lstat.mockResolvedValue({ isDirectory: () => true });
  mocks.readdir.mockResolvedValue([]);
  mocks.statfs.mockResolvedValue({ type: 0xef53 });
  mocks.stat.mockResolvedValue({ dev: 1, ino: 42 });
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.unlink.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
describe("optional ext4 casefold", () => {
  it("proves inode equality and removes the probe", async () => {
    expect(await enableDirectoryCasefold("/test/staging")).toBe(true);
    expect(mocks.execute).toHaveBeenCalledWith("chattr", ["+F", "/test/staging"], {
      timeout: 10000,
    });
    expect(mocks.stat.mock.calls[0]![0]).not.toBe(mocks.stat.mock.calls[1]![0]);
    expect(mocks.writeFile).toHaveBeenCalledWith(expect.any(String), "", {
      flag: "wx",
      mode: 0o600,
    });
    expect(mocks.unlink).toHaveBeenCalledOnce();
  });
  it("leaves existing files alone", async () => {
    mocks.readdir.mockResolvedValue(["installed-mod"]);
    expect(await enableDirectoryCasefold("/test/staging")).toBe(false);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("does not follow symlinks", async () => {
    mocks.lstat.mockResolvedValue({ isDirectory: () => false });
    expect(await enableDirectoryCasefold("/test/staging")).toBe(false);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("skips unsupported filesystems", async () => {
    mocks.statfs.mockResolvedValue({ type: 0x9123683e });
    expect(await enableDirectoryCasefold("/test/staging")).toBe(false);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("skips Flatpak", async () => {
    vi.stubEnv("FLATPAK_ID", "test.nyastra");
    expect(await enableDirectoryCasefold("/test/staging")).toBe(false);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("cleans up after a failed case probe", async () => {
    mocks.stat.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    expect(await enableDirectoryCasefold("/test/staging")).toBe(false);
    expect(mocks.unlink).toHaveBeenCalledOnce();
  });
});
