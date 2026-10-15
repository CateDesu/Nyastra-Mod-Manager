import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import PromiseBB from "bluebird";
import { afterEach, describe, expect, vi } from "vitest";

import { test } from "../../test-utils/installManagerTest";
import * as fs from "../../util/fs";

vi.mock("../../logging", () => ({ log: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe("installer file boundaries", () => {
  test("waits for an in-flight file transfer before returning another file's error", async ({
    makeInstallManager,
  }) => {
    const { api, manager } = makeInstallManager();
    const root = await mkdtemp(path.join(tmpdir(), "nyastra-installer-"));
    let release: () => void = () => undefined;
    const pending = new PromiseBB<void>((resolve) => (release = resolve));
    let failed = false;
    try {
      vi.spyOn(fs, "linkAsync")
        .mockRejectedValueOnce(Object.assign(new Error("write failed"), { code: "EIO" }))
        .mockImplementationOnce(() => pending);
      const result = manager["extractArchive"](
        api,
        "mod.zip",
        path.join(root, "extracted"),
        path.join(root, "staging"),
        [
          { type: "copy", source: "a.txt", destination: "a.txt" },
          { type: "copy", source: "b.txt", destination: "b.txt" },
        ],
        "skyrimse",
      ).catch(() => {
        failed = true;
      });
      await vi.waitFor(() => expect(fs.linkAsync).toHaveBeenCalledTimes(2));
      try {
        expect(failed).toBe(false);
      } finally {
        release();
        await result;
      }
      expect(failed).toBe(true);
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  });

  test.for(["", ".", "folder/..", "/.", "/folder/..", "\\."])(
    "rejects a file instruction targeting the staging root: %s",
    async (destination, { makeInstallManager }) => {
      const { api, manager } = makeInstallManager();
      expect(
        manager["validateInstructions"]([{ type: "copy", source: "mod.txt", destination }]),
      ).not.toHaveLength(0);
      const root = await mkdtemp(path.join(tmpdir(), "nyastra-installer-root-"));
      try {
        const extracted = path.join(root, "extracted");
        const staging = path.join(root, "staging");
        await mkdir(extracted);
        await mkdir(staging);
        await writeFile(path.join(extracted, "mod.txt"), "new mod");
        await writeFile(path.join(staging, "existing.txt"), "keep existing files");
        await expect(
          manager["processInstructions"](
            api,
            undefined,
            "mod.zip",
            extracted,
            staging,
            "skyrimse",
            "mod",
            { instructions: [{ type: "copy", source: "mod.txt", destination }] },
            undefined,
            true,
            undefined,
          ),
        ).rejects.toThrow("Invalid installer instructions");
        expect(await readFile(path.join(staging, "existing.txt"), "utf8")).toBe(
          "keep existing files",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.for(["ENOSPC", "EIO"])(
    "rejects a failed fallback copy with %s",
    async (code, { makeInstallManager }) => {
      const { api, manager } = makeInstallManager();
      const root = await mkdtemp(path.join(tmpdir(), "nyastra-installer-"));
      try {
        const source = path.join(root, "extracted");
        const destination = path.join(root, "staging");
        await mkdir(source);
        await writeFile(path.join(source, "mod.txt"), "mod data");
        vi.spyOn(fs, "linkAsync").mockRejectedValue(
          Object.assign(new Error("cross device"), { code: "EXDEV" }),
        );
        const failure = Object.assign(new Error("copy failed"), { code });
        vi.spyOn(fs, "copyAsync").mockRejectedValue(failure);
        await expect(
          manager["extractArchive"](
            api,
            "mod.zip",
            source,
            destination,
            [{ type: "copy", source: "mod.txt", destination: "mod.txt" }],
            "skyrimse",
          ),
        ).rejects.toBe(failure);
        expect(await readFile(path.join(source, "mod.txt"), "utf8")).toBe("mod data");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.for(["../outside.txt", "folder/../../outside.txt", "..\\outside.txt"])(
    "rejects an installer destination escaping staging: %s",
    async (destination, { makeInstallManager }) => {
      const { manager } = makeInstallManager();
      expect(
        manager["validateInstructions"]([{ type: "copy", source: "mod.txt", destination }]),
      ).not.toHaveLength(0);
    },
  );

  test.for(["../outside.txt", "..\\outside.txt", "/outside.txt"])(
    "rejects an installer source outside the extracted archive: %s",
    async (source, { makeInstallManager }) => {
      const { manager } = makeInstallManager();
      expect(
        manager["validateInstructions"]([{ type: "copy", source, destination: "mod.txt" }]),
      ).not.toHaveLength(0);
    },
  );

  test("accepts nested archive paths and the legacy leading destination separator", async ({
    makeInstallManager,
  }) => {
    const { manager } = makeInstallManager();
    expect(
      manager["validateInstructions"]([
        { type: "copy", source: "Data/mod.txt", destination: "Data/mod.txt" },
        { type: "copy", source: "mod.txt", destination: "/Data/mod.txt" },
        { type: "mkdir", destination: "Data" },
      ]),
    ).toEqual([]);
  });
});
