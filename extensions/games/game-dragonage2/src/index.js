const path = require("path");
const { fs, util } = require("@nexusmods/vortex-api");

const STEAM_IDS = ["15543", "1238040"];

function findGame() {
  return util.GameStoreHelper.findByAppId(STEAM_IDS).then((game) => game.gamePath);
}

function queryModPath() {
  return path.join(
    util.getVortexPath("documents"),
    "BioWare",
    "Dragon Age 2",
    "packages",
    "core",
    "override",
  );
}

function prepareForModding() {
  return fs.ensureDirAsync(queryModPath());
}

function main(context) {
  context.requireExtension("modtype-dazip");
  context.registerGame({
    id: "dragonage2",
    name: "Dragon Age 2",
    mergeMods: true,
    queryPath: findGame,
    queryModPath,
    logo: "gameart.jpg",
    executable: () => "bin_ship/dragonage2.exe",
    setup: prepareForModding,
    requiredFiles: ["bin_ship/dragonage2.exe"],
    details: {},
  });

  return true;
}

module.exports = {
  default: main,
};
