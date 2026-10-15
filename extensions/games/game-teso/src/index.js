const { log, util } = require("@nexusmods/vortex-api");

const path = require("path");

function findGame() {
  return util.GameStoreHelper.findByName("The Elder Scrolls Online", "steam").then(
    (game) => game.gamePath,
  );
}

function modPath() {
  return path.join(util.getVortexPath("documents"), "Elder Scrolls Online", "live", "Addons");
}

function main(context) {
  context.registerGame({
    id: "teso",
    name: "The Elder Scrolls Online",
    mergeMods: true,
    queryPath: findGame,
    queryModPath: modPath,
    logo: "gameart.jpg",
    executable: () => "Bethesda.net_Launcher.exe",
    requiredFiles: [],
    environment: {
      SteamAPPId: "306130",
    },
    details: {
      steamAppId: 306130,
      nexusPageId: "elderscrollsonline",
      hashFiles: [
        "../The Elder Scrolls Online/game/game_player.version",
        "../The Elder Scrolls Online/depot/depot.version",
        "Bethesda.net_Launcher.version",
      ],
    },
  });

  return true;
}

module.exports = {
  default: main,
};
