import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePathCase, resolvePathCaseSync } from "./resolvePathCase";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nyastra-case-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("case-sensitive filesystem compatibility", () => {
  it("resolves every directory and the leaf filename", async () => {
    mkdirSync(path.join(root, "Textures/Armor"), { recursive: true });
    writeFileSync(path.join(root, "Textures/Armor/Steel.dds"), "texture");
    const expected = path.join(root, "Textures/Armor/Steel.dds");
    await expect(resolvePathCase(root, "textures\\armor\\steel.dds")).resolves.toBe(expected);
    expect(resolvePathCaseSync(root, "textures/armor/steel.dds")).toBe(expected);
  });
  it("prefers an exact filename when both cases exist", async () => {
    writeFileSync(path.join(root, "Data"), "one");
    writeFileSync(path.join(root, "data"), "two");
    await expect(resolvePathCase(root, "data")).resolves.toBe(path.join(root, "data"));
  });
  it("rejects ambiguous casing instead of choosing an arbitrary file", async () => {
    writeFileSync(path.join(root, "Data"), "one");
    writeFileSync(path.join(root, "data"), "two");
    await expect(resolvePathCase(root, "DATA")).rejects.toMatchObject({ code: "EEXIST" });
    expect(() => resolvePathCaseSync(root, "DATA")).toThrow("Ambiguous filename casing");
  });
  it("retains missing path segments without creating anything", async () => {
    await expect(resolvePathCase(root, "New/Folder/File.txt")).resolves.toBe(
      path.join(root, "New/Folder/File.txt"),
    );
    expect(readdirSync(root)).toEqual([]);
  });
  it("shares pending directory lookups across parallel deployment paths", async () => {
    const cache = new Map<string, Promise<string[]>>();
    const [first, second] = await Promise.all([
      resolvePathCase(root, "textures/One.dds", cache),
      resolvePathCase(root, "Textures/Two.dds", cache),
    ]);
    expect(path.dirname(first)).toBe(path.dirname(second));
  });
});
