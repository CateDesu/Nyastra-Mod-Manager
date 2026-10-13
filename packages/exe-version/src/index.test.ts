import * as fs from "fs";
import * as path from "path";

import { describe, it, expect } from "vitest";

import exeVersion, {
  getFileVersion,
  getProductVersion,
  getFileVersionLocalized,
  getProductVersionLocalized,
} from "./index";
import { readVersionInfo } from "./peVersion";

// a small PE with version info that ships in the repo
const DIVINE_EXE = path.resolve(
  import.meta.dirname,
  "../../../extensions/games/game-baldursgate3/tools/divine.exe",
);

describe("public API (cross-platform)", () => {
  it("reads the file version", () => {
    expect(getFileVersion(DIVINE_EXE)).toBe("1.0.0.0");
  });

  it("reads the localized product version", () => {
    expect(getProductVersionLocalized(DIVINE_EXE)).toBe("1.0.0.0");
  });
});
