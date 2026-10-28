import path from "node:path";

import { expect, it } from "vitest";

import { archiveOutputPath } from "./archivePath";

it.each(["meshes\\weapons\\sword.nif", "meshes/weapons/sword.nif"])(
  "maps archive separators to a native path: %s",
  (name) => {
    expect(archiveOutputPath("/extracted", name)).toBe(
      path.join("/extracted", "meshes", "weapons", "sword.nif"),
    );
  },
);

it.each(["", ".", "../sibling/file", "..\\sibling\\file", "/outside/file"])(
  "rejects entries outside the extraction directory: %s",
  (name) => {
    expect(() => archiveOutputPath("/extracted", name)).toThrow(
      "Archive entry is outside the extraction directory",
    );
  },
);
