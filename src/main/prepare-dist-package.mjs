import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { prepareLinuxFomod } from "./prepare-linux-native.mjs";

const MAIN_DIR = resolve(import.meta.dirname);
const MAIN_PACKAGE_PATH = resolve(MAIN_DIR, "package.json");
const DIST_DIR = resolve(MAIN_DIR, "build");
const DIST_PACKAGE_PATH = resolve(DIST_DIR, "package.json");

async function resolveDepVersions(deps, nodeModulesDir) {
  if (!deps) return deps;
  const resolved = { ...deps };
  for (const [name, version] of Object.entries(deps)) {
    if (
      version === "catalog:" ||
      version.startsWith("workspace:") ||
      version.startsWith("file:") ||
      version.includes("@file:")
    ) {
      try {
        const pkgJson = JSON.parse(
          await readFile(resolve(nodeModulesDir, name, "package.json"), "utf8"),
        );
        resolved[name] = pkgJson.version;
      } catch {
        // leave as-is if not found in node_modules
      }
    }
  }
  return resolved;
}

async function main() {
  const json = await readFile(MAIN_PACKAGE_PATH, "utf8");
  const mainPkg = JSON.parse(json);

  mainPkg["name"] = "nyastra-mod-manager";
  mainPkg["productName"] = "Nyastra's Mod Manager";
  mainPkg["main"] = mainPkg.main.replace(/^build\//, "");

  // NOTE(erri120): this is the minimal amount of bullshit required to get the piece of shit software called "electron-builder" to work with PNPM.
  const nodeModulesDir = resolve(MAIN_DIR, "node_modules");
  mainPkg.dependencies = await resolveDepVersions(mainPkg.dependencies, nodeModulesDir);
  mainPkg.devDependencies = await resolveDepVersions(mainPkg.devDependencies, nodeModulesDir);
  mainPkg.optionalDependencies = await resolveDepVersions(
    mainPkg.optionalDependencies,
    nodeModulesDir,
  );

  await writeFile(DIST_PACKAGE_PATH, JSON.stringify(mainPkg, null, 2) + "\n", "utf8");

  await prepareLinuxFomod(resolve(nodeModulesDir, "@nexusmods", "fomod-installer-native"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
