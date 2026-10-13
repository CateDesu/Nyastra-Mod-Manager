import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function findRuntimeAsset(candidates, label) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  throw new Error(
    `Missing Linux FOMOD ${label}. Reinstall dependencies and rebuild native modules.`,
  );
}

export async function prepareLinuxFomod(packageRoot) {
  const releaseDir = resolve(packageRoot, "build", "Release");
  const prebuildDir = resolve(packageRoot, "prebuilds", `linux-${process.arch}`);
  const addonPath = resolve(releaseDir, "modinstaller.node");
  const libraryPath = resolve(releaseDir, "ModInstaller.Native.so");
  const addonSource = await findRuntimeAsset(
    [addonPath, resolve(prebuildDir, "modinstaller.napi.node")],
    "native addon",
  );
  const librarySource = await findRuntimeAsset(
    [
      libraryPath,
      resolve(packageRoot, "ModInstaller.Native.so"),
      resolve(prebuildDir, "ModInstaller.Native.so"),
    ],
    "shared library",
  );

  await mkdir(releaseDir, { recursive: true });
  if (librarySource !== libraryPath) await copyFile(librarySource, libraryPath);

  // pnpm can hardlink deployed files to its store. Patch a private copy.
  const tempDirectory = await mkdtemp(resolve(releaseDir, ".vortex-fomod-"));
  const tempAddon = resolve(tempDirectory, "modinstaller.node");
  try {
    await copyFile(addonSource, tempAddon);
    await execFileAsync("patchelf", ["--set-rpath", "$ORIGIN", tempAddon]);
    await rename(tempAddon, addonPath);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error("Linux packaging requires patchelf. Install patchelf and add it to PATH.", {
        cause: err,
      });
    }
    throw err;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
