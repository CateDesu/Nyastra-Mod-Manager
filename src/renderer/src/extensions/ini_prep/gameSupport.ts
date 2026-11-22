import * as path from "path";

import format from "string-template";

import getVortexPath from "../../util/getVortexPath";
import { getMyGamesPath } from "../../util/linux/proton";
import steam, { type ISteamEntry } from "../../util/Steam";
import { makeOverlayableDictionary } from "../../util/util";
import type { IDiscoveryResult } from "../gamemode_management/types/IDiscoveryResult";

interface IGameSupport {
  iniFiles: string[];
  iniFormat: string;
  optionalFiles?: string[];
}

const gameSupport = makeOverlayableDictionary<string, IGameSupport>(
  {
    skyrim: {
      iniFiles: [
        path.join("{mygames}", "Skyrim", "Skyrim.ini"),
        path.join("{mygames}", "Skyrim", "SkyrimPrefs.ini"),
      ],
      iniFormat: "winapi",
    },
    enderal: {
      iniFiles: [
        path.join("{mygames}", "Enderal", "Enderal.ini"),
        path.join("{mygames}", "Enderal", "EnderalPrefs.ini"),
      ],
      iniFormat: "winapi",
    },
    skyrimse: {
      optionalFiles: ["SkyrimCustom.ini"],
      iniFiles: [
        path.join("{mygames}", "Skyrim Special Edition", "Skyrim.ini"),
        path.join("{mygames}", "Skyrim Special Edition", "SkyrimPrefs.ini"),
        path.join("{mygames}", "Skyrim Special Edition", "SkyrimCustom.ini"),
      ],
      iniFormat: "winapi",
    },
    enderalspecialedition: {
      iniFiles: [
        path.join("{mygames}", "Enderal Special Edition", "Enderal.ini"),
        path.join("{mygames}", "Enderal Special Edition", "EnderalPrefs.ini"),
      ],
      iniFormat: "winapi",
    },
    skyrimvr: {
      iniFiles: [
        path.join("{mygames}", "Skyrim VR", "Skyrim.ini"),
        path.join("{mygames}", "Skyrim VR", "SkyrimVR.ini"),
        path.join("{mygames}", "Skyrim VR", "SkyrimPrefs.ini"),
      ],
      iniFormat: "winapi",
    },
    fallout3: {
      optionalFiles: ["FalloutCustom.ini"],
      iniFiles: [
        path.join("{mygames}", "Fallout3", "Fallout.ini"),
        path.join("{mygames}", "Fallout3", "FalloutPrefs.ini"),
        path.join("{mygames}", "Fallout3", "FalloutCustom.ini"),
      ],
      iniFormat: "winapi",
    },
    fallout4: {
      optionalFiles: ["Fallout4Custom.ini"],
      iniFiles: [
        path.join("{mygames}", "Fallout4", "Fallout4.ini"),
        path.join("{mygames}", "Fallout4", "Fallout4Prefs.ini"),
        path.join("{mygames}", "Fallout4", "Fallout4Custom.ini"),
      ],
      iniFormat: "winapi",
    },
    fallout4vr: {
      iniFiles: [
        path.join("{mygames}", "Fallout4VR", "Fallout4Custom.ini"),
        path.join("{mygames}", "Fallout4VR", "Fallout4Prefs.ini"),
      ],
      iniFormat: "winapi",
    },
    falloutnv: {
      optionalFiles: ["FalloutCustom.ini"],
      iniFiles: [
        path.join("{mygames}", "FalloutNV", "Fallout.ini"),
        path.join("{mygames}", "FalloutNV", "FalloutPrefs.ini"),
        path.join("{mygames}", "FalloutNV", "FalloutCustom.ini"),
      ],
      iniFormat: "winapi",
    },
    starfield: {
      optionalFiles: ["Starfield.ini"],
      iniFiles: [
        path.join("{mygames}", "Starfield", "Starfield.ini"),
        path.join("{mygames}", "Starfield", "StarfieldPrefs.ini"),
        path.join("{mygames}", "Starfield", "StarfieldCustom.ini"),
      ],
      iniFormat: "winapi",
    },
    oblivion: {
      iniFiles: [path.join("{mygames}", "Oblivion", "Oblivion.ini")],
      iniFormat: "winapi",
    },
    oblivionremastered: {
      iniFiles: [
        path.join("{mygames}", "Oblivion Remastered", "Saved", "Config", "Windows", "Altar.ini"),
      ],
      iniFormat: "winapi",
    },
    morrowind: {
      iniFiles: [path.join("{game}", "Morrowind.ini")],
      iniFormat: "winapi",
    },
  },
  {
    gog: {
      skyrimse: {
        iniFiles: [
          path.join("{mygames}", "Skyrim Special Edition GOG", "Skyrim.ini"),
          path.join("{mygames}", "Skyrim Special Edition GOG", "SkyrimPrefs.ini"),
          path.join("{mygames}", "Skyrim Special Edition GOG", "SkyrimCustom.ini"),
        ],
        iniFormat: "winapi",
      },
      enderalspecialedition: {
        iniFiles: [
          path.join("{mygames}", "Enderal Special Edition GOG", "Enderal.ini"),
          path.join("{mygames}", "Enderal Special Edition GOG", "EnderalPrefs.ini"),
        ],
        iniFormat: "winapi",
      },
    },
    epic: {
      skyrimse: {
        iniFiles: [
          path.join("{mygames}", "Skyrim Special Edition EPIC", "Skyrim.ini"),
          path.join("{mygames}", "Skyrim Special Edition EPIC", "SkyrimPrefs.ini"),
          path.join("{mygames}", "Skyrim Special Edition EPIC", "SkyrimCustom.ini"),
        ],
        iniFormat: "winapi",
      },
      fallout4: {
        iniFiles: [
          path.join("{mygames}", "Fallout4 EPIC", "Fallout4.ini"),
          path.join("{mygames}", "Fallout4 EPIC", "Fallout4Prefs.ini"),
          path.join("{mygames}", "Fallout4 EPIC", "Fallout4Custom.ini"),
        ],
        iniFormat: "winapi",
      },
    },
    xbox: {
      skyrimse: {
        iniFiles: [
          path.join("{mygames}", "Skyrim Special Edition MS", "Skyrim.ini"),
          path.join("{mygames}", "Skyrim Special Edition MS", "SkyrimPrefs.ini"),
          path.join("{mygames}", "Skyrim Special Edition MS", "SkyrimCustom.ini"),
        ],
        iniFormat: "winapi",
      },
      fallout4: {
        iniFiles: [
          path.join("{mygames}", "Fallout4 MS", "Fallout4.ini"),
          path.join("{mygames}", "Fallout4 MS", "Fallout4Prefs.ini"),
          path.join("{mygames}", "Fallout4 MS", "Fallout4Custom.ini"),
        ],
        iniFormat: "winapi",
      },
    },
    enderalOverride: {
      enderalspecialedition: {
        optionalFiles: ["SkyrimCustom.ini"],
        iniFiles: [
          path.join("{mygames}", "Skyrim Special Edition", "Skyrim.ini"),
          path.join("{mygames}", "Skyrim Special Edition", "SkyrimPrefs.ini"),
          path.join("{mygames}", "Skyrim Special Edition", "SkyrimCustom.ini"),
        ],
        iniFormat: "winapi",
      },
    },
  },
  (gameId: string, store: string) => store,
);

function gameStore(gameMode: string, discovery: IDiscoveryResult): string {
  if (
    gameMode === "enderalspecialedition" &&
    discovery?.path !== undefined &&
    discovery.path.toLowerCase().includes("skyrim")
  ) {
    return "enderalOverride";
  }
  return discovery?.store;
}

export function optionalIniFiles(gameMode: string, discovery: IDiscoveryResult): string[] {
  return gameSupport.get(gameMode, "optionalFiles", gameStore(gameMode, discovery)) ?? [];
}

export function iniFiles(gameMode: string, discovery: IDiscoveryResult) {
  const entry =
    process.platform === "linux" && discovery?.store === "steam"
      ? (steam.snapshot().entries.find((candidate) => candidate.gamePath === discovery.path) as
          | ISteamEntry
          | undefined)
      : undefined;
  const mygames = discovery?.protonPrefix
    ? path.join(discovery.protonPrefix, "drive_c", "users", "steamuser", "Documents", "My Games")
    : entry?.usesProton && entry.compatDataPath
      ? getMyGamesPath(entry.compatDataPath)
      : path.join(getVortexPath("documents"), "My Games");

  return (gameSupport.get(gameMode, "iniFiles", gameStore(gameMode, discovery)) ?? []).map(
    (filePath) => format(filePath, { mygames, game: discovery.path }),
  );
}

export function iniFormat(gameMode: string) {
  return gameSupport.get(gameMode, "iniFormat");
}
