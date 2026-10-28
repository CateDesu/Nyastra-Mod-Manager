import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { types } from "@nexusmods/vortex-api";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@nexusmods/vortex-api", async () => {
  const filesystem = await import("node:fs/promises");
  return {
    fs: { readFileAsync: filesystem.readFile },
    util: {
      deBOM: (input: string) => input.replace(/^\uFEFF/, ""),
      DataInvalid: class extends Error {},
    },
    log: vi.fn<(...args: unknown[]) => void>(),
  };
});

import { installStardewValley, testSupported } from "./stardewValleyInstaller";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function archive(contents: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "nyastra-sdv-manifest-"));
  roots.push(root);
  const extracted = path.join(root, "extracted");
  const installed = path.join(root, "installed");
  await mkdir(extracted);
  await mkdir(installed);
  for (const [relative, data] of Object.entries(contents)) {
    const file = path.join(extracted, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }
  const files: string[] = [];
  async function list(directory: string) {
    for (const entry of await readdir(path.join(extracted, directory), { withFileTypes: true })) {
      const relative = path.join(directory, entry.name);
      files.push(relative + (entry.isDirectory() ? path.sep : ""));
      if (entry.isDirectory()) await list(relative);
    }
  }
  await list("");
  return { extracted, installed, files };
}

const manifest = (name: string) =>
  JSON.stringify({
    Name: name,
    UniqueID: `Fixture.${name}`,
    Version: "1.0.0",
    EntryDll: "mod.dll",
  });

async function install(contents: Record<string, string>) {
  const fixture = await archive(contents);
  expect(await testSupported(fixture.files, "stardewvalley")).toMatchObject({ supported: true });
  const showErrorNotification = vi.fn<(...args: unknown[]) => void>();
  const result = await installStardewValley(
    { showErrorNotification } as unknown as types.IExtensionApi,
    fixture.files,
    fixture.extracted,
  );
  expect(showErrorNotification).not.toHaveBeenCalled();
  const installed: Record<string, string> = {};
  for (const instruction of result.instructions) {
    expect(instruction.type).toBe("copy");
    const destination = path.join(fixture.installed, instruction.destination!);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(fixture.extracted, instruction.source!), destination);
    expect(Object.hasOwn(installed, instruction.destination!)).toBe(false);
    installed[instruction.destination!] = await readFile(destination, "utf8");
  }
  for (const [relative, bytes] of Object.entries(contents)) {
    expect(await readFile(path.join(fixture.extracted, relative), "utf8")).toBe(bytes);
  }
  return installed;
}

describe("Stardew manifest installer file boundaries", () => {
  it("installs an archive-root manifest and its payload into the named mod", async () => {
    const contents = { "manifest.json": manifest("RootMod"), "mod.dll": "root-assembly" };
    expect(await install(contents)).toEqual({
      [path.join("RootMod", "manifest.json")]: contents["manifest.json"],
      [path.join("RootMod", "mod.dll")]: "root-assembly",
    });
  });

  it("preserves a nested mod and extensionless payloads", async () => {
    const contents = {
      [path.join("Wrapped", "Mod", "manifest.json")]: manifest("Mod"),
      [path.join("Wrapped", "Mod", "mod.dll")]: "nested-assembly",
      [path.join("Wrapped", "Mod", "assets", "payload")]: "extensionless-asset",
    };
    expect(await install(contents)).toEqual(contents);
  });

  it("does not import another sibling with the same final folder name", async () => {
    const own = path.join("Selected", "Mod");
    const contents = {
      [path.join(own, "manifest.json")]: manifest("SelectedMod"),
      [path.join(own, "mod.dll")]: "selected-assembly",
      [path.join("Unrelated", "Mod", "other.dll")]: "unrelated-assembly",
      [path.join("Selected", "ModExtra", "neighbor.dll")]: "neighbor-assembly",
    };
    expect(await install(contents)).toEqual({
      [path.join(own, "manifest.json")]: contents[path.join(own, "manifest.json")]!,
      [path.join(own, "mod.dll")]: "selected-assembly",
    });
  });

  it("uses the directory boundary when its name contains manifest.json", async () => {
    const contents = {
      [path.join("manifest.json-assets", "manifest.json")]: manifest("NamedFolder"),
      [path.join("manifest.json-assets", "mod.dll")]: "named-folder-assembly",
    };
    expect(await install(contents)).toEqual(contents);
  });

  it("preserves the existing ordinary nested-mod layout", async () => {
    const contents = {
      [path.join("Standard", "manifest.json")]: manifest("Standard"),
      [path.join("Standard", "mod.dll")]: "standard-assembly",
      [path.join("Standard", "assets", "data.json")]: '{"value":"standard"}',
    };
    expect(await install(contents)).toEqual(contents);
  });

  it("reports a genuinely invalid manifest without emitting copy instructions", async () => {
    const fixture = await archive({ "manifest.json": "{invalid" });
    const showErrorNotification = vi.fn<(...args: unknown[]) => void>();
    const result = await installStardewValley(
      { showErrorNotification } as unknown as types.IExtensionApi,
      fixture.files,
      fixture.extracted,
    );
    expect(result.instructions).toEqual([]);
    expect(showErrorNotification).toHaveBeenCalledOnce();
  });
});
