import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { prepareLinuxFomod } from "./prepare-linux-native.mjs";

if (process.env.VORTEX_ELECTRON_REBUILD === "skip") {
  console.log("Skipping electron-rebuild because VORTEX_ELECTRON_REBUILD=skip.");
  process.exit(0);
}

if (process.platform === "linux") {
  const require = createRequire(import.meta.url);
  // Finish Electron's lazy download before parallel test workers can request it.
  require("electron");
  if (process.env.VORTEX_ELECTRON_REBUILD === "defer") {
    console.log("Deferring electron-rebuild because VORTEX_ELECTRON_REBUILD=defer.");
    process.exit(0);
  }
  const { rebuild } = await import("@electron/rebuild");
  // FOMOD ships a stable N-API prebuild. Its source build breaks in paths with spaces.
  await rebuild({
    buildPath: import.meta.dirname,
    electronVersion: require("electron/package.json").version,
    ignoreModules: ["@nexusmods/fomod-installer-native"],
  });
  await prepareLinuxFomod(
    realpathSync(resolve(import.meta.dirname, "node_modules/@nexusmods/fomod-installer-native")),
  );
}
