import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findLatestProton,
  getProtonInfo,
  resolveProtonPath,
  buildProtonEnvironment,
  getMyGamesPath,
} from "./proton";

vi.mock("../fs", async () => {
  const nativeFs = await import("node:fs/promises");
  return {
    statAsync: nativeFs.stat,
    readdirAsync: nativeFs.readdir,
    readFileAsync: nativeFs.readFile,
  };
});
vi.mock("../log", () => ({ log: vi.fn() }));

let root: string;
let steamPath: string;
let gameLibrary: string;
let toolLibrary: string;

function writeFixture(filePath: string, contents = ""): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function installProton(library: string, name: string): string {
  const directory = path.join(library, "steamapps", "common", name);
  writeFixture(path.join(directory, "proton"), "#!/usr/bin/env python3\n");
  return directory;
}

function configureProton(mapping: Record<string, string>): void {
  writeFixture(
    path.join(steamPath, "config", "config.vdf"),
    [
      '"InstallConfigStore"',
      "{",
      '"Software"',
      "{",
      '"Valve"',
      "{",
      '"Steam"',
      "{",
      '"CompatToolMapping"',
      "{",
      ...Object.entries(mapping).flatMap(([appId, name]) => [
        `"${appId}"`,
        "{",
        `"name" "${name}"`,
        "}",
      ]),
      "}",
      "}",
      "}",
      "}",
      "}",
    ].join("\n"),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-proton-"));
  steamPath = path.join(root, "Steam");
  gameLibrary = path.join(root, "Game Library");
  toolLibrary = path.join(root, "Tool Library");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Proton discovery across Steam libraries", () => {
  it("recognizes a Windows-only game before its prefix has been created", async () => {
    const protonPath = installProton(toolLibrary, "Proton 9.0");
    const steamAppsPath = path.join(gameLibrary, "steamapps");
    await expect(
      getProtonInfo(steamPath, steamAppsPath, "42", [toolLibrary], "windows"),
    ).resolves.toEqual({
      usesProton: true,
      compatDataPath: path.join(steamAppsPath, "compatdata", "42"),
      protonPath,
    });
  });

  it("does not override an existing Proton prefix when the manifest also lists Linux", async () => {
    const steamAppsPath = path.join(gameLibrary, "steamapps");
    fs.mkdirSync(path.join(steamAppsPath, "compatdata", "42"), { recursive: true });
    expect(
      (await getProtonInfo(steamPath, steamAppsPath, "42", [], "windows,linux")).usesProton,
    ).toBe(true);
  });

  it("uses the Proton username for Windows save paths", () => {
    expect(getMyGamesPath("/library/compatdata/42")).toBe(
      "/library/compatdata/42/pfx/drive_c/users/steamuser/Documents/My Games",
    );
  });

  it("passes the game IDs and retains user environment values", () => {
    const env = buildProtonEnvironment("/prefix", "/steam", { CUSTOM: "kept" }, "42");
    expect(env).toMatchObject({
      CUSTOM: "kept",
      SteamAppId: "42",
      SteamGameId: "42",
      WINEPREFIX: "/prefix/pfx",
    });
  });
  it("keeps the game's prefix while resolving its configured Proton from another library", async () => {
    configureProton({ "42": "proton_9" });
    const protonPath = installProton(toolLibrary, "Proton 9.0");
    const steamAppsPath = path.join(gameLibrary, "steamapps");
    const compatDataPath = path.join(steamAppsPath, "compatdata", "42");
    fs.mkdirSync(path.join(compatDataPath, "pfx"), { recursive: true });

    await expect(
      getProtonInfo(steamPath, steamAppsPath, "42", [steamPath, gameLibrary, toolLibrary]),
    ).resolves.toEqual({ usesProton: true, compatDataPath, protonPath });
  });

  it("also searches the game's library when no library list is supplied", async () => {
    configureProton({ "42": "proton_experimental" });
    const protonPath = installProton(gameLibrary, "Proton - Experimental");
    const steamAppsPath = path.join(gameLibrary, "steamapps");
    fs.mkdirSync(path.join(steamAppsPath, "compatdata", "42"), { recursive: true });

    expect((await getProtonInfo(steamPath, steamAppsPath, "42")).protonPath).toBe(protonPath);
  });

  it("retains Steam-root runtime discovery", async () => {
    const protonPath = installProton(steamPath, "Proton 9.0");

    await expect(resolveProtonPath(steamPath, "proton_9")).resolves.toBe(protonPath);
  });

  it("inherits Steam's default compatibility tool when the game has no override", async () => {
    configureProton({ "0": "GE-Proton10-28" });
    const protonPath = path.join(steamPath, "compatibilitytools.d", "GE-Proton10-28");
    writeFixture(path.join(protonPath, "proton"));
    const steamAppsPath = path.join(gameLibrary, "steamapps");
    fs.mkdirSync(path.join(steamAppsPath, "compatdata", "42", "pfx"), { recursive: true });

    expect((await getProtonInfo(steamPath, steamAppsPath, "42")).protonPath).toBe(protonPath);
  });

  it("prefers the game's explicit compatibility tool over Steam's default", async () => {
    configureProton({ "0": "GE-Proton10-28", "42": "proton_9" });
    writeFixture(path.join(steamPath, "compatibilitytools.d", "GE-Proton10-28", "proton"));
    const protonPath = installProton(toolLibrary, "Proton 9.0");
    const steamAppsPath = path.join(gameLibrary, "steamapps");
    fs.mkdirSync(path.join(steamAppsPath, "compatdata", "42", "pfx"), { recursive: true });

    expect((await getProtonInfo(steamPath, steamAppsPath, "42", [toolLibrary])).protonPath).toBe(
      protonPath,
    );
  });

  it("prefers the configured custom runtime over an official runtime", async () => {
    installProton(toolLibrary, "Proton 10.0");
    const customPath = path.join(steamPath, "compatibilitytools.d", "GE-Proton10-28");
    writeFixture(path.join(customPath, "proton"));

    await expect(resolveProtonPath(steamPath, "GE-Proton10-28", [toolLibrary])).resolves.toBe(
      customPath,
    );
  });

  it("resolves an exact configured runtime directory in an external library", async () => {
    const protonPath = installProton(toolLibrary, "Proton Custom");

    await expect(resolveProtonPath(steamPath, "Proton Custom", [toolLibrary])).resolves.toBe(
      protonPath,
    );
  });

  it("skips missing libraries and incomplete runtime downloads", async () => {
    fs.mkdirSync(path.join(steamPath, "steamapps", "common", "Proton 9.0"), { recursive: true });
    const protonPath = installProton(toolLibrary, "Proton 9.0");

    await expect(
      resolveProtonPath(steamPath, "proton_9", [gameLibrary, toolLibrary]),
    ).resolves.toBe(protonPath);
  });

  it("matches the configured version rather than a substring in another version", async () => {
    installProton(steamPath, "Proton 19.0");
    installProton(steamPath, "Proton 10.9");
    const protonPath = installProton(toolLibrary, "Proton 9.0");

    await expect(resolveProtonPath(steamPath, "proton_9", [toolLibrary])).resolves.toBe(protonPath);
  });

  it("chooses the latest numeric fallback across libraries and ignores incomplete downloads", async () => {
    installProton(steamPath, "Proton 9.0");
    const protonPath = installProton(toolLibrary, "Proton 10.0");
    fs.mkdirSync(path.join(gameLibrary, "steamapps", "common", "Proton 99.0"), { recursive: true });

    await expect(findLatestProton(steamPath, [gameLibrary, toolLibrary])).resolves.toBe(protonPath);
  });

  it("does not infer Proton use for a game without a compatibility prefix", async () => {
    installProton(toolLibrary, "Proton 10.0");

    await expect(
      getProtonInfo(steamPath, path.join(gameLibrary, "steamapps"), "42", [toolLibrary]),
    ).resolves.toEqual({ usesProton: false });
  });
});
