import { execFile } from "node:child_process";
import { copyFile, link, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareLinuxFomod } from "./prepare-linux-native.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tempDirectories: string[] = [];

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "vortex-linux-fomod-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "linux")("Linux FOMOD packaging", () => {
  it("loads XML installer support after moving the package away from its build directory", async () => {
    const directory = await createFixture();
    const packageRoot = join(directory, "package");
    const prebuildDir = join(packageRoot, "prebuilds", `linux-${process.arch}`);
    const installedPackageRoot = dirname(
      require.resolve("@nexusmods/fomod-installer-native/package.json"),
    );
    const installedPrebuildDir = join(installedPackageRoot, "prebuilds", `linux-${process.arch}`);
    await mkdir(prebuildDir, { recursive: true });
    for (const file of ["modinstaller.napi.node", "ModInstaller.Native.so"]) {
      await copyFile(join(installedPrebuildDir, file), join(prebuildDir, file));
    }
    const prebuiltAddon = join(prebuildDir, "modinstaller.napi.node");
    await execFileAsync("patchelf", [
      "--set-rpath",
      join(directory, "missing build tree"),
      prebuiltAddon,
    ]);
    await expect(
      execFileAsync(process.execPath, ["-e", "require(process.argv[1])", prebuiltAddon]),
    ).rejects.toThrow("ModInstaller.Native.so");

    await prepareLinuxFomod(packageRoot);
    const movedPackageRoot = join(directory, "moved package");
    await rename(packageRoot, movedPackageRoot);
    const movedAddon = join(movedPackageRoot, "build", "Release", "modinstaller.node");
    const { stdout: rpath } = await execFileAsync("patchelf", ["--print-rpath", movedAddon]);
    expect(rpath.trim()).toBe("$ORIGIN");
    const { stdout } = await execFileAsync(process.execPath, [
      "-e",
      "const addon = require(process.argv[1]); console.log(JSON.stringify(addon.ModInstaller.testSupported(['fomod/ModuleConfig.xml'], ['XmlScript'])))",
      movedAddon,
    ]);
    expect(JSON.parse(stdout)).toMatchObject({ supported: true });
  });

  it("reports a missing shared library before packaging an unusable addon", async () => {
    const packageRoot = await createFixture();
    await mkdir(join(packageRoot, "build", "Release"), { recursive: true });
    const installedPackageRoot = dirname(
      require.resolve("@nexusmods/fomod-installer-native/package.json"),
    );
    await copyFile(
      join(installedPackageRoot, "prebuilds", `linux-${process.arch}`, "modinstaller.napi.node"),
      join(packageRoot, "build", "Release", "modinstaller.node"),
    );
    await expect(prepareLinuxFomod(packageRoot)).rejects.toThrow(
      "Missing Linux FOMOD shared library",
    );
  });

  it("preserves the source addon when pnpm deploys it as a hardlink", async () => {
    const directory = await createFixture();
    const installedPackageRoot = dirname(
      require.resolve("@nexusmods/fomod-installer-native/package.json"),
    );
    const prebuildDir = join(installedPackageRoot, "prebuilds", `linux-${process.arch}`);
    const sourceAddon = join(directory, "store-addon.node");
    await copyFile(join(prebuildDir, "modinstaller.napi.node"), sourceAddon);
    const sourceBytes = await readFile(sourceAddon);
    const { stdout: originalRpath } = await execFileAsync("patchelf", [
      "--print-rpath",
      sourceAddon,
    ]);
    const packageRoot = join(directory, "package");
    const releaseDir = join(packageRoot, "build", "Release");
    await mkdir(releaseDir, { recursive: true });
    await link(sourceAddon, join(releaseDir, "modinstaller.node"));
    await copyFile(
      join(prebuildDir, "ModInstaller.Native.so"),
      join(releaseDir, "ModInstaller.Native.so"),
    );

    await prepareLinuxFomod(packageRoot);

    expect(await readFile(sourceAddon)).toEqual(sourceBytes);
    const { stdout: preservedRpath } = await execFileAsync("patchelf", [
      "--print-rpath",
      sourceAddon,
    ]);
    expect(preservedRpath).toBe(originalRpath);
    const { stdout: deployedRpath } = await execFileAsync("patchelf", [
      "--print-rpath",
      join(releaseDir, "modinstaller.node"),
    ]);
    expect(deployedRpath.trim()).toBe("$ORIGIN");
  });

  it("explains how to resolve a missing patchelf build tool", async () => {
    const directory = await createFixture();
    const installedPackageRoot = dirname(
      require.resolve("@nexusmods/fomod-installer-native/package.json"),
    );
    const releaseDir = join(directory, "build", "Release");
    await mkdir(releaseDir, { recursive: true });
    for (const [source, target] of [
      ["modinstaller.napi.node", "modinstaller.node"],
      ["ModInstaller.Native.so", "ModInstaller.Native.so"],
    ] as const) {
      await copyFile(
        join(installedPackageRoot, "prebuilds", `linux-${process.arch}`, source),
        join(releaseDir, target),
      );
    }
    vi.stubEnv("PATH", "");
    await expect(prepareLinuxFomod(directory)).rejects.toThrow("Linux packaging requires patchelf");
  });
});
