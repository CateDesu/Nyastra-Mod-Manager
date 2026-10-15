const fs = require("fs");
const { parseString } = require("xml2js");
const path = require("path");

const { util } = require("@nexusmods/vortex-api");

let version;

function queryModPath(api, gamePath) {
  if (version === undefined) {
    try {
      const data = fs.readFileSync(path.join(gamePath, "version.xml"), { encoding: "utf8" });
      parseString(data, (err, res) => {
        if (err) {
          throw err;
        }
        version = res?.["version.xml"]?.version?.[0];
        version = version.replace(/ ?v.([0-9.]*) .*/, "$1");
        fs.statSync(path.join(gamePath, "res_mods", version));
      });
    } catch (parseErr) {
      version = undefined;
      api.showErrorNotification(
        "Game not installed",
        "World of Tanks doesn't seem to be installed correctly. " +
          "Please check the version.xml file in your game directory.",
        { allowReport: false, id: "wot-not-installed" },
      );
      return ".";
    }
  }

  return path.join(gamePath, "res_mods", version);
}

function main(context) {
  context.registerGame({
    id: "worldoftanks",
    name: "World Of Tanks",
    mergeMods: true,

    queryModPath: (gamePath) => queryModPath(context.api, gamePath),
    logo: "gameart.jpg",
    executable: () => "WorldOfTanks.exe",
    requiredFiles: ["WorldOfTanks.exe", "version.xml"],
    details: {},
  });

  return true;
}

module.exports = {
  default: main,
};
