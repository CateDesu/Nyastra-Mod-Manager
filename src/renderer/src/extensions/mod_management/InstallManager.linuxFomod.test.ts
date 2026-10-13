import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Zip from "node-7z";
import { afterEach, describe, expect, vi } from "vitest";
import { XXHash64 } from "xxhash-addon";

import type { IInstallManagerHarness } from "../../test-utils/harnessTypes";
import { test as imTest } from "../../test-utils/installManagerTest";
import { SetupError } from "../../util/CustomErrors";
import type { IFileListItem } from "./types/IMod";

vi.mock("../../logging", () => ({ log: vi.fn() }));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const temporaryDirectories: string[] = [];

afterEach(() => {
  if (platformDescriptor !== undefined) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function prepareInstall(
  harness: IInstallManagerHarness,
  files: string[],
  platform: string,
  extractList?: IFileListItem[],
) {
  Object.defineProperty(process, "platform", { value: platform });
  const directory = mkdtempSync(path.join(tmpdir(), "vortex-linux-fomod-"));
  temporaryDirectories.push(directory);
  const zip = new Zip();
  harness.manager["extractWithRetry"] = vi.fn(
    (_zip: Zip, _archive: string, destination: string) => {
      for (const file of files) {
        const filename = path.join(destination, file);
        mkdirSync(path.dirname(filename), { recursive: true });
        writeFileSync(filename, file);
      }
      return Promise.resolve({ code: 0, errors: [] });
    },
  );

  const testSupported = vi.fn(() => Promise.resolve({ supported: true, requiredFiles: [] }));
  const install = vi.fn(() => Promise.resolve({ instructions: [] }));
  harness.manager.addInstaller("fallback", 100, testSupported, install);

  const run = () =>
    harness.manager["installInner"](
      harness.api,
      path.join(directory, "mod.7z"),
      path.join(directory, "extracted"),
      path.join(directory, "installed"),
      "falloutnv",
      {
        startIndicator: vi.fn(),
        stopIndicator: vi.fn(),
        setProgress: vi.fn(),
        startInstallCB: vi.fn(),
        finishInstallCB: vi.fn(),
        progressCB: vi.fn(),
        reportError: vi.fn(),
      },
      zip,
      undefined,
      undefined,
      extractList,
    );

  return { run, testSupported, install };
}

describe("Linux C# FOMOD installation", () => {
  imTest(
    "rejects a script-only archive before consent or fallback installation",
    async ({ makeInstallManager }) => {
      const harness = makeInstallManager();
      const { run, testSupported, install } = prepareInstall(
        harness,
        ["Wrapped/FOMOD/Script.CS", "Wrapped/Data/example.esp"],
        "linux",
      );

      const result = run();
      await expect(result).rejects.toBeInstanceOf(SetupError);
      await expect(result).rejects.toThrow("C# FOMOD installers are not supported by native Linux");
      expect(harness.dialogCalls).toEqual([]);
      expect(testSupported).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
    },
  );

  imTest(
    "keeps XML installation available when the archive also includes C#",
    async ({ makeInstallManager }) => {
      const harness = makeInstallManager();
      const { run, testSupported, install } = prepareInstall(
        harness,
        ["fomod/Script.cs", "fomod/ModuleConfig.xml", "Data/example.esp"],
        "linux",
      );

      await expect(run()).resolves.toMatchObject({ installerId: "fallback" });
      expect(testSupported).toHaveBeenCalledWith(
        expect.any(Array),
        "falloutnv",
        expect.any(String),
        { hasCSScripts: true, hasXmlConfigXML: true },
      );
      expect(install).toHaveBeenCalledOnce();
    },
  );

  for (const platform of ["linux"]) {
    imTest(
      `uses explicit file choices instead of unused C# on ${platform}`,
      async ({ makeInstallManager }) => {
        const harness = makeInstallManager();
        const selectedFile = "Data/example.esp";
        const { run, testSupported, install } = prepareInstall(
          harness,
          ["fomod/Script.cs", selectedFile],
          platform,
          [
            {
              path: "example.esp",
              xxh64: XXHash64.hash(Buffer.from(selectedFile)).toString("base64"),
            },
          ],
        );

        await expect(run()).resolves.toMatchObject({
          installerId: "list-installer",
          instructions: [{ type: "copy", source: selectedFile, destination: "example.esp" }],
        });
        expect(testSupported).not.toHaveBeenCalled();
        expect(install).not.toHaveBeenCalled();
      },
    );
  }
});
