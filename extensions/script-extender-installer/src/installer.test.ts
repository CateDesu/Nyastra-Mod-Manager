import { expect, test, vi } from "vitest";

vi.mock("./util", () => ({ getScriptExtenderVersion: async () => "2.2.6" }));

import { installScriptExtender, testSupported } from "./installer";

test("a root extender archive retains extensionless files and excludes directories", async () => {
  const files = ["skse64_loader.exe", "LICENSE", "Data/", "Data/Scripts/test.pex"];
  const { instructions } = await installScriptExtender(files, "/synthetic", "skyrimse");
  expect(instructions.filter((instruction) => instruction.type === "copy")).toEqual([
    { type: "copy", source: "skse64_loader.exe", destination: "skse64_loader.exe" },
    { type: "copy", source: "LICENSE", destination: "LICENSE" },
    { type: "copy", source: "Data/Scripts/test.pex", destination: "Data/Scripts/test.pex" },
  ]);
});

test("a wrapped extender archive copies only files beneath the loader's directory", async () => {
  const files = [
    "skse/skse64_loader.exe",
    "skse/Data/Scripts/test.pex",
    "skse-old/skse64_loader.exe",
    "docs/skse/notes.txt",
  ];
  const { instructions } = await installScriptExtender(files, "/synthetic", "skyrimse");
  expect(instructions.filter((instruction) => instruction.type === "copy")).toEqual([
    { type: "copy", source: "skse/skse64_loader.exe", destination: "skse64_loader.exe" },
    { type: "copy", source: "skse/Data/Scripts/test.pex", destination: "Data/Scripts/test.pex" },
  ]);
});

test("recognizes the same loader casing that installation accepts", async () => {
  await expect(testSupported(["SKSE64_LOADER.EXE"], "skyrimse")).resolves.toMatchObject({
    supported: true,
  });
});
