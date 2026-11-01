import { expect, test, vi } from "vitest";

import { parseCommandline, relaunch } from "./cli";

const lifecycle = vi.hoisted(() => ({
  relaunch: vi.fn<(options: { args: string[] }) => void>(),
  close: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { name: "Nyastra test", getVersion: () => "2.9.2", relaunch: lifecycle.relaunch },
  BrowserWindow: { getAllWindows: () => [{ close: lifecycle.close }] },
}));
vi.mock("./getVortexPath", () => ({ getVortexPath: () => "/unused-startup-fixture" }));
vi.mock("./logging", () => ({ log: vi.fn() }));

const url = "nxm://fixture/mods/1/files/2";
const electron = "/fixture/electron";
const program = "/fixture/program";

for (const option of ["--install", "-i", "--download", "-d"]) {
  test(`reordered source launch preserves ${option} and its URL`, () => {
    // Captured Electron second-instance shape with switches before positional values.
    const parsed = parseCommandline(
      [
        electron,
        option,
        "--allow-file-access-from-files",
        "--ozone-platform=wayland",
        "--disable-gpu",
        program,
        url,
      ],
      true,
    );
    const download = ["--download", "-d"].includes(option);
    expect(parsed.install).toBe(download ? undefined : url);
    expect(parsed.download).toBe(download ? url : undefined);
  });
}

for (const args of [
  [electron, program, url],
  [electron, program, "--install", url],
  ["/fixture/nyastra-mod-manager", "--install", url],
]) {
  test(`cold launch preserves its URL with arguments ${args.slice(0, -1).join(" ")}`, () => {
    expect(parseCommandline(args, false).install).toBe(url);
  });
}

test("reordered packaged launch preserves its URL", () => {
  expect(
    parseCommandline(["/fixture/nyastra-mod-manager", "--install", "--disable-gpu", url], true)
      .install,
  ).toBe(url);
});

for (const source of [false, true]) {
  test(`reordered minimized launch keeps its storage option with source=${source}`, () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Command line rejected");
    });
    try {
      const parsed = parseCommandline(
        [
          source ? electron : "/fixture/nyastra-mod-manager",
          "--start-minimized",
          "--user-data",
          "--disable-features=WidgetLayering",
          "--disable-features=UseEcoQoSForBackgroundProcess",
          ...(source ? [program] : []),
          "/fixture/custom profile",
        ],
        true,
      );
      expect(parsed.startMinimized).toBe(true);
      expect(parsed.userData).toBe("/fixture/custom profile");
    } finally {
      exit.mockRestore();
    }
  });
}

for (const minimized of [false, true]) {
  test(`restart keeps custom storage after a launch with minimized=${minimized}`, () => {
    const executable = "/fixture/nyastra-mod-manager";
    const original = process.argv;
    lifecycle.relaunch.mockClear();
    lifecycle.close.mockClear();
    try {
      process.argv = [
        executable,
        ...(minimized ? ["--start-minimized"] : []),
        "--user-data",
        "/fixture/custom profile",
      ];
      relaunch();
    } finally {
      process.argv = original;
    }
    expect(lifecycle.relaunch).toHaveBeenCalledTimes(1);
    expect(lifecycle.close).toHaveBeenCalledTimes(1);
    const call = lifecycle.relaunch.mock.calls[0];
    if (call === undefined) throw new Error("Missing relaunch call");
    const { args } = call[0];
    const parsed = parseCommandline([executable, ...args], false);
    expect(parsed.userData).toBe("/fixture/custom profile");
    expect(parsed.startMinimized).toBeUndefined();
  });
}
