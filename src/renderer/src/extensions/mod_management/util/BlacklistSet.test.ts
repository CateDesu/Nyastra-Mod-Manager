import { describe, expect, it } from "vitest";

import type { IGame } from "../../../types/IGame";
import BlacklistSet from "./BlacklistSet";

const game = {
  details: { ignoreDeploy: ["**/junk/**", "**/.cache/**", "**/*.bak"] },
} as unknown as IGame;
const skip = () => new BlacklistSet([], game, (input) => input);

describe("deployment skip patterns", () => {
  it("skips Apple archive metadata and hidden files matched by a pattern", () => {
    expect(skip().has("__MACOSX/._plugin.esp")).toBe(true);
    expect(skip().has(".cache/plugin.esp")).toBe(true);
    expect(skip().has(".hidden/junk/file.txt")).toBe(true);
  });
  it("keeps hidden mod files outside skip patterns", () => {
    expect(skip().has(".config/settings.ini")).toBe(false);
  });
});
