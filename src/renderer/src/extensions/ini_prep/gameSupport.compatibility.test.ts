import path from "node:path";

import { expect, test, vi } from "vitest";

vi.mock("../../util/getVortexPath", () => ({ default: () => "/isolated/documents" }));
vi.mock("../../util/Steam", () => ({ default: { snapshot: () => ({ entries: [] }) } }));

import { iniFiles, optionalIniFiles } from "./gameSupport";

test.each(["/games/skyrim/Enderal", "/games/Skyrim/Enderal"])(
  "uses Skyrim INIs for the Enderal overlay at %s",
  (gamePath) => {
    const discovery = { path: gamePath, store: "steam", protonPrefix: "/isolated/prefix" };
    const directory = path.join(
      discovery.protonPrefix,
      "drive_c",
      "users",
      "steamuser",
      "Documents",
      "My Games",
      "Skyrim Special Edition",
    );
    expect(iniFiles("enderalspecialedition", discovery)).toEqual(
      ["Skyrim.ini", "SkyrimPrefs.ini", "SkyrimCustom.ini"].map((name) =>
        path.join(directory, name),
      ),
    );
    expect(optionalIniFiles("enderalspecialedition", discovery)).toEqual(["SkyrimCustom.ini"]);
  },
);

test("keeps standalone GOG Enderal paths", () => {
  expect(iniFiles("enderalspecialedition", { path: "/games/Enderal", store: "gog" })).toEqual(
    ["Enderal.ini", "EnderalPrefs.ini"].map((name) =>
      path.join("/isolated/documents/My Games/Enderal Special Edition GOG", name),
    ),
  );
});
