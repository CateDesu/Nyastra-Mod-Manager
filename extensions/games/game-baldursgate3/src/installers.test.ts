import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("./util", () => ({ logDebug: vi.fn() }));

import { installReplacer } from "./installers";

function archiveEntries(files: string[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    for (
      let directory = path.dirname(file);
      directory !== ".";
      directory = path.dirname(directory)
    ) {
      directories.add(directory + path.sep);
    }
  }
  return [...directories, ...files];
}

describe("Baldur's Gate 3 replacer archives", () => {
  it.each(["Data", "data", "DATA"])("keeps original source paths under %s", async (data) => {
    const source = path.join("Wrapper", data, "Public", "Example", "data.lsf");
    const { instructions } = await installReplacer(archiveEntries([source]));
    expect(instructions).toEqual([
      { type: "copy", source, destination: path.join("Public", "Example", "data.lsf") },
    ]);
  });

  it("includes double-dot child names and excludes sibling folders", async () => {
    const source = path.join("DATA", "..cache", "data.lsf");
    const { instructions } = await installReplacer(
      archiveEntries([source, path.join("DATA2", "unrelated.txt")]),
    );
    expect(instructions).toEqual([
      { type: "copy", source, destination: path.join("..cache", "data.lsf") },
    ]);
  });

  it("accepts an uppercase data root and preserves a rootless archive", async () => {
    const source = path.join("WRAPPER", "DATA", "PUBLIC", "data.lsf");
    expect((await installReplacer(archiveEntries([source]))).instructions).toEqual([
      { type: "copy", source, destination: path.join("PUBLIC", "data.lsf") },
    ]);
    expect((await installReplacer(["data.lsf"])).instructions).toEqual([
      { type: "copy", source: "data.lsf", destination: "data.lsf" },
    ]);
  });
});
