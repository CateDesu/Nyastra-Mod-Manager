const Promise = require("bluebird");
const path = require("path");

const { fs, util } = require("@nexusmods/vortex-api");

const GAME_ID = "neverwinter2";
const MODULE_EXT = ".mod";

function modPath() {
  return path.join(util.getVortexPath("documents"), "Neverwinter Nights 2");
}

function overrideModPath() {
  return path.join(util.getVortexPath("documents"), "Neverwinter Nights 2", "override");
}

function modulesModPath() {
  return path.join(util.getVortexPath("documents"), "Neverwinter Nights 2", "modules");
}

function install(files) {
  const instructions = files
    .filter((file) => path.extname(path.basename(file)) === MODULE_EXT)
    .map((file) => ({
      type: "copy",
      source: file,
      destination: path.join("modules", path.basename(file)),
    }));

  return Promise.resolve({ instructions });
}

function testSupported(files, gameId) {
  if (GAME_ID !== gameId) {
    // Not NWN2
    return Promise.resolve({ supported: false, requiredFiles: [] });
  }

  // Only allow mods which contain .mod files - we "allow" .txt and .doc files in case the mod
  //  author included a readme file.
  const unsupportedFiles = files.filter(
    (file) =>
      path.extname(path.basename(file)) !== "" &&
      [".txt", ".doc", MODULE_EXT].indexOf(path.extname(file)) === -1,
  );

  return Promise.resolve({
    supported: unsupportedFiles.length === 0,
    requiredFiles: [],
  });
}

async function prepareForModding(discovery) {
  try {
    await fs.ensureDirWritableAsync(modulesModPath());
    await fs.ensureDirWritableAsync(overrideModPath());
  } catch (err) {
    return Promise.reject(err);
  }
}

function main(context) {
  context.registerGame({
    id: GAME_ID,
    name: "Neverwinter Nights 2",
    mergeMods: true,

    queryModPath: modPath,
    logo: "gameart.jpg",
    executable: () => "nwn2.exe",
    requiredFiles: ["nwn2.exe"],
    setup: prepareForModding,
  });

  // This installer will only support mods with .mod files.
  context.registerInstaller("moduleinstaller", 25, testSupported, install);

  context.registerModType(
    "nwn2-override-mod",
    25,
    (gameId) => gameId === GAME_ID,
    () => overrideModPath(),
    () => Promise.resolve(false),
    { name: "NWN2 Override Mod" },
  );

  return true;
}

module.exports = {
  default: main,
};
