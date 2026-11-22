import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IExtension } from "../../types/extensions";
import { DataInvalid } from "../../util/CustomErrors";
import {
  extensionOwners,
  validateExtension,
  validateTheme,
  validateTranslation,
} from "./installExtension";

// installExtension.ts imports named bindings from "node:fs/promises"; only a full
// vi.mock() factory reliably intercepts those calls (spying on the live module
// object does not, since Vite's ESM handling gives each import site its own
// binding). Mirrors the pattern in reconcileOrphanedArchive.test.ts.
const { statMock, readdirMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  readdirMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => {
  const mocked = {
    stat: statMock,
    readdir: readdirMock,
    rename: vi.fn(),
    rm: vi.fn(),
    writeFile: vi.fn(),
    access: vi.fn(),
    copyFile: vi.fn(),
    mkdir: vi.fn(),
  };
  return { ...mocked, default: mocked };
});

describe("extension directory owners", () => {
  const target = "/plugins/Fixture";
  it("retires all keys for the installed directory while preserving distinct folders", () => {
    expect(
      extensionOwners(
        {
          Fixture: { path: target },
          "catalog name": { path: target },
          previous: { path: target + " v1" },
          lowercase: { path: target.toLowerCase() },
          legacy: { path: undefined },
        },
        target,
      ),
    ).toEqual(["Fixture", "catalog name"]);
  });

  it("leaves an unowned installation alone", () => {
    expect(extensionOwners({}, target)).toEqual([]);
  });
});

interface FakeDirent {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
  parentPath?: string;
}

function dir(name: string): FakeDirent {
  return { name, isDirectory: () => true, isFile: () => false };
}

function file(name: string): FakeDirent {
  return { name, isDirectory: () => false, isFile: () => true };
}

describe("validate* extension install checks", () => {
  beforeEach(() => {
    statMock.mockReset();
    readdirMock.mockReset();
  });

  // Resolves readdir() calls based on the path argument, stamping `parentPath`
  // onto each entry the way node:fs/promises does for real Dirents.
  const mockDirTree = (tree: Record<string, FakeDirent[]>): void => {
    readdirMock.mockImplementation(async (p: string) => {
      const entries = tree[p] ?? [];
      return entries.map((entry) => ({ ...entry, parentPath: p }));
    });
  };

  describe("validateExtension", () => {
    const extPath = path.join("mock", "extension");

    it("resolves when index.js and info.json both exist", async () => {
      statMock.mockResolvedValue({} as never);
      await expect(validateExtension(extPath)).resolves.toBeUndefined();
      expect(statMock).toHaveBeenCalledWith(path.join(extPath, "index.js"));
      expect(statMock).toHaveBeenCalledWith(path.join(extPath, "info.json"));
    });

    it("rejects when index.js is missing", async () => {
      statMock.mockImplementation(async (p: string) => {
        if (p.endsWith("index.js")) throw new Error("ENOENT");
        return {} as never;
      });
      await expect(validateExtension(extPath)).rejects.toThrow("ENOENT");
    });

    it("rejects when info.json is missing", async () => {
      statMock.mockImplementation(async (p: string) => {
        if (p.endsWith("info.json")) throw new Error("ENOENT");
        return {} as never;
      });
      await expect(validateExtension(extPath)).rejects.toThrow("ENOENT");
    });
  });

  describe("validateTheme", () => {
    const extPath = path.join("mock", "theme-ext");

    it("throws when there are no subdirectories", async () => {
      mockDirTree({ [extPath]: [file("readme.txt")] });
      await expect(validateTheme(extPath)).rejects.toThrow(
        "Expected a subdirectory containing the stylesheets",
      );
    });

    it.each(["variables.scss", "style.scss", "fonts.scss"])(
      "resolves when the subdirectory contains %s",
      async (required) => {
        const themeDir = path.join(extPath, "default");
        mockDirTree({
          [extPath]: [dir("default")],
          [themeDir]: [file(required)],
        });
        await expect(validateTheme(extPath)).resolves.toBeUndefined();
      },
    );

    it("throws 'Theme not found' when a subdirectory has none of the required files", async () => {
      const themeDir = path.join(extPath, "default");
      mockDirTree({
        [extPath]: [dir("default")],
        [themeDir]: [file("readme.txt")],
      });
      await expect(validateTheme(extPath)).rejects.toThrow("Theme not found");
    });

    it("resolves for a multi-theme extension where every subdirectory is valid", async () => {
      const lightDir = path.join(extPath, "light");
      const darkDir = path.join(extPath, "dark");
      mockDirTree({
        [extPath]: [dir("light"), dir("dark")],
        [lightDir]: [file("variables.scss")],
        [darkDir]: [file("fonts.scss")],
      });
      await expect(validateTheme(extPath)).resolves.toBeUndefined();
    });

    it("throws when at least one of several subdirectories is invalid", async () => {
      const lightDir = path.join(extPath, "light");
      const brokenDir = path.join(extPath, "broken");
      mockDirTree({
        [extPath]: [dir("light"), dir("broken")],
        [lightDir]: [file("variables.scss")],
        [brokenDir]: [file("readme.txt")],
      });
      await expect(validateTheme(extPath)).rejects.toThrow("Theme not found");
    });
  });

  describe("validateTranslation", () => {
    const extPath = path.join("mock", "translation-ext");

    it("throws when there are no locale-like subdirectories", async () => {
      // "docs" isn't a well-formed BCP-47 tag, so isValidBcp47 rejects it and
      // the filter removes it.
      mockDirTree({ [extPath]: [dir("docs"), file("readme.txt")] });
      await expect(validateTranslation(extPath)).rejects.toThrow(
        "Expected exactly one language subdirectory",
      );
    });

    it("throws when there is more than one locale-like subdirectory", async () => {
      mockDirTree({ [extPath]: [dir("en"), dir("de")] });
      await expect(validateTranslation(extPath)).rejects.toThrow(
        "Expected exactly one language subdirectory",
      );
    });

    it("ignores non-locale directories when counting language subdirectories", async () => {
      const langDir = path.join(extPath, "en");
      mockDirTree({
        [extPath]: [dir("docs"), dir("en")],
        [langDir]: [file("strings.json")],
      });
      await expect(validateTranslation(extPath)).resolves.toBeUndefined();
    });

    it("treats a private-use tag as not a language code", async () => {
      // "xx" is well-formed BCP-47 but isValidBcp47 rejects it, so it is
      // filtered out and we report the same error as the empty case.
      mockDirTree({ [extPath]: [dir("xx")] });
      await expect(validateTranslation(extPath)).rejects.toThrow(
        "Expected exactly one language subdirectory",
      );
    });

    it("treats a known language with an unknown region as not a language code", async () => {
      // "en-XX" is structurally fine, but isValidBcp47 rejects unknown regions.
      mockDirTree({ [extPath]: [dir("en-XX")] });
      await expect(validateTranslation(extPath)).rejects.toThrow(
        "Expected exactly one language subdirectory",
      );
    });

    it("accepts a script subtag (zh-Hans)", async () => {
      const langDir = path.join(extPath, "zh-Hans");
      mockDirTree({
        [extPath]: [dir("zh-Hans")],
        [langDir]: [file("strings.json")],
      });
      await expect(validateTranslation(extPath)).resolves.toBeUndefined();
    });

    it("accepts a script subtag with a region (zh-Hant-CN)", async () => {
      const langDir = path.join(extPath, "zh-Hant-CN");
      mockDirTree({
        [extPath]: [dir("zh-Hant-CN")],
        [langDir]: [file("strings.json")],
      });
      await expect(validateTranslation(extPath)).resolves.toBeUndefined();
    });

    it("throws 'No translation files' when the language directory has no json files", async () => {
      const langDir = path.join(extPath, "en");
      mockDirTree({
        [extPath]: [dir("en")],
        [langDir]: [file("readme.txt")],
      });
      await expect(validateTranslation(extPath)).rejects.toThrow("No translation files");
    });

    it("resolves when the language directory contains a json file", async () => {
      const langDir = path.join(extPath, "en");
      mockDirTree({
        [extPath]: [dir("en")],
        [langDir]: [file("strings.json")],
      });
      await expect(validateTranslation(extPath)).resolves.toBeUndefined();
    });
  });
});
