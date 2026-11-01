import type { IParameters } from "@vortex/shared/cli";
import { beforeEach, expect, test, vi } from "vitest";

import { filterArgs, parseCommandline, relaunch } from "./cli";

const lifecycle = vi.hoisted(() => ({
  relaunch: vi.fn<(options: { args: string[] }) => void>(),
  close: vi.fn<() => void>(),
}));
vi.mock("electron", () => ({
  app: { name: "Nyastra test", getVersion: () => "2.9.2", relaunch: lifecycle.relaunch },
  BrowserWindow: { getAllWindows: () => [{ close: lifecycle.close }] },
}));
vi.mock("./getVortexPath", () => ({ getVortexPath: () => "/unused-startup-fixture" }));
vi.mock("./logging", () => ({ log: vi.fn<(...args: unknown[]) => void>() }));

const url = "nxm://fixture/mods/1/files/2";
const storage = "/fixture/custom profile";
const sourceProgram = "/fixture/source program";

beforeEach(() => vi.clearAllMocks());

function restart(argv: string[], extra?: string[]) {
  const original = process.argv;
  try {
    process.argv = argv;
    relaunch(extra);
  } finally {
    process.argv = original;
  }
  expect(lifecycle.relaunch).toHaveBeenCalledTimes(1);
  expect(lifecycle.close).toHaveBeenCalledTimes(1);
  const call = lifecycle.relaunch.mock.calls[0];
  if (call === undefined) throw new Error("Missing relaunch call");
  return call[0].args;
}

const actions: { option: string; key: keyof IParameters; value: string }[] = [
  { option: "--restore", key: "restore", value: "/fixture/backup file.json" },
  { option: "--merge", key: "merge", value: "/fixture/merge file.json" },
  { option: "--install-archive", key: "installArchive", value: "/fixture/mod archive.zip" },
  { option: "--install", key: "install", value: url },
  { option: "--download", key: "download", value: url },
  { option: "--game", key: "game", value: "fixture-game" },
  { option: "--profile", key: "profile", value: "fixture-profile" },
  { option: "-i", key: "install", value: url },
  { option: "-d", key: "download", value: url },
];

for (const { option, key, value } of actions) {
  for (const attached of [false, true]) {
    for (const source of [false, true]) {
      test(`restart consumes ${option} with attached=${attached} and source=${source}`, () => {
        const executable = source ? "/fixture/electron" : "/fixture/nyastra-mod-manager";
        const prefix = source ? [sourceProgram] : [];
        const action = attached
          ? [option + (option.startsWith("--") ? "=" : "") + value]
          : [option, value];
        const persistent = attached ? [`--user-data=${storage}`] : ["--user-data", storage];
        persistent.push("--inspector", "--max-memory", "8192", "--disable-gpu");
        const argv = [executable, ...prefix, ...action, ...persistent];
        expect(parseCommandline(argv, false)[key]).toBe(value);
        const args = restart(argv);
        expect(args).toEqual([...prefix, ...persistent]);
        const parsed = parseCommandline([executable, ...args], false);
        expect(parsed[key]).toBeUndefined();
        expect(parsed.userData).toBe(storage);
        expect(parsed.inspector).toBe(true);
        expect(parsed.maxMemory).toBe("8192");
      });
    }
  }
}

for (const bare of [url, url.replace("nxm", "NXM")]) {
  test(`restart consumes the bare ${bare} action without swallowing storage`, () => {
    const argv = ["/fixture/nyastra-mod-manager", bare, "--user-data", storage];
    expect(parseCommandline(argv, false).install).toBe(bare);
    const args = restart(argv);
    expect(args).toEqual(["--user-data", storage]);
    const parsed = parseCommandline([argv[0] ?? "", ...args], false);
    expect(parsed.install).toBeUndefined();
    expect(parsed.userData).toBe(storage);
  });
}

for (const option of ["--user-data", "--max-memory", "--report", "--epic-auth-login"]) {
  for (const value of [url, "-iaccount", "--restore=literal-value"]) {
    test(`restart preserves the literal value ${value} belonging to ${option}`, () => {
      const persistent = [option, value, "--inspector"];
      expect(filterArgs(["/fixture/nyastra-mod-manager", ...persistent])).toEqual(persistent);
    });
  }
}

test("restart preserves unrelated switches and appends new actions exactly", () => {
  const persistent = [
    sourceProgram,
    "--user-data",
    storage,
    "--install-mode=manual",
    "--download-cache=/fixture/cache",
    "--disable-gpu",
  ];
  const extra = ["--install", url, "--profile", "new-profile"];
  const args = restart(["/fixture/electron", ...persistent], extra);
  expect(args).toEqual([...persistent, ...extra]);
  const parsed = parseCommandline(["/fixture/electron", ...args], false);
  expect(parsed.userData).toBe(storage);
  expect(parsed.install).toBe(url);
  expect(parsed.profile).toBe("new-profile");
});

const epicOptions: { raw: string; normalized: string; key: string }[] = [
  { raw: "-AUTH_LOGIN", normalized: "--epic-auth-login", key: "epicAuthLogin" },
  { raw: "-AUTH_PASSWORD", normalized: "--epic-auth-password", key: "epicAuthPassword" },
  { raw: "-AUTH_TYPE", normalized: "--epic-auth-type", key: "epicAuthType" },
  { raw: "-epicapp", normalized: "--epic-app", key: "epicApp" },
  { raw: "-epicenv", normalized: "--epic-env", key: "epicEnv" },
  { raw: "-epicusername", normalized: "--epic-username", key: "epicUsername" },
  { raw: "-epicuserid", normalized: "--epic-userid", key: "epicUserid" },
  { raw: "-epiclocale", normalized: "--epic-locale", key: "epicLocale" },
  { raw: "-epicsandboxid", normalized: "--epic-sandboxid", key: "epicSandboxid" },
];

for (const { raw, normalized, key } of epicOptions) {
  for (const option of [raw, normalized]) {
    for (const value of ["usual-account", "-iaccount", "--restore=literal-value"]) {
      for (const inline of [false, true]) {
        test(`restart preserves Epic ${option} value ${value} with inline=${inline}`, () => {
          const executable = "/fixture/nyastra-mod-manager";
          const epic = inline ? [`${option}=${value}`] : [option, value];
          const persistent = [...epic, "--user-data", storage, "--inspector"];
          const argv = [executable, ...persistent];
          const expected = { [key]: value, userData: storage, inspector: true };
          expect(parseCommandline(argv, false)).toMatchObject(expected);
          const args = restart(argv);
          expect(args).toEqual(persistent);
          expect(parseCommandline([executable, ...args], false)).toMatchObject(expected);
        });
      }
    }

    test(`filter keeps literal ${option} owned by the preceding persistent option`, () => {
      const persistent = ["--report", option, "--user-data", storage, "--inspector"];
      const input = [
        "/fixture/nyastra-mod-manager",
        "--report",
        option,
        "--restore=/fixture/backup.json",
        "--user-data",
        storage,
        "--inspector",
      ];
      expect(filterArgs(input)).toEqual(persistent);
    });
  }
}

for (const option of ["-EpicPortal", "--epic-portal"]) {
  test(`restart keeps zero-arity ${option} while consuming the following action`, () => {
    const executable = "/fixture/nyastra-mod-manager";
    const argv = [
      executable,
      option,
      "--restore=/fixture/backup.json",
      "--user-data",
      storage,
      "--inspector",
    ];
    const first = parseCommandline(argv, false);
    expect(first).toMatchObject({ epicPortal: true, restore: "/fixture/backup.json" });
    const args = restart(argv);
    expect(args).toEqual([option, "--user-data", storage, "--inspector"]);
    const next = parseCommandline([executable, ...args], false);
    expect(next).toMatchObject({ epicPortal: true, userData: storage, inspector: true });
    expect(next.restore).toBeUndefined();
  });
}
