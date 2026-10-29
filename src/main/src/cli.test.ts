import { expect, test, vi } from "vitest";

import { parseCommandline } from "./cli";

vi.mock("electron", () => ({ app: { name: "Nyastra test", getVersion: () => "2.9.2" } }));
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
