import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Bluebird from "bluebird";
import * as crc32 from "crc-32";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeApiHarness, makeMod } from "../../../test-utils/builders";
import type { IApiHarness } from "../../../test-utils/harnessTypes";
import { DataInvalid } from "../../../util/CustomErrors";
import * as fs from "../../../util/fs";
import type { IMod } from "../../mod_management/types/IMod";
import { applyPatches } from "./binaryPatching";

let root: string;
let staging: string;
let harness: IApiHarness;
let collection: IMod;
let previousApi: typeof window.api;
const crc = (data: string) => (crc32.str(data) >>> 0).toString(16).toUpperCase().padStart(8, "0");

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nyastra-patches-"));
  staging = path.join(root, "staging");
  await mkdir(path.join(staging, "member"), { recursive: true });
  await mkdir(path.join(staging, "collection", "patches", "Member"), { recursive: true });
  collection = makeMod({ id: "collection", installationPath: "collection" });
  harness = makeApiHarness({
    installPath: { skyrimse: staging },
    mods: { skyrimse: { member: makeMod({ id: "member", installationPath: "member" }) } },
  });
  previousApi = window.api;
  window.api = {
    ...previousApi,
    bsdiff: {
      ...previousApi.bsdiff,
      patch: vi.fn(async (_source, output) => writeFile(output, "patched")),
    },
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  window.api = previousApi;
  await rm(root, { recursive: true, force: true });
});

describe("collection patch file boundaries", () => {
  it.each([
    "../outside",
    "folder/../../outside",
    "..\\outside",
    "/outside",
    "C:\\outside",
    "",
    ".",
  ])("rejects the unsafe patch file %s before file access", async (file) => {
    const stat = vi.spyOn(fs, "statAsync");
    await applyPatches(harness.api, collection, "skyrimse", "Member", "member", {
      [file]: "00000000",
    });
    expect(stat).not.toHaveBeenCalled();
    expect(harness.errorNotifications[0]?.message).toBeInstanceOf(DataInvalid);
    expect(window.api.bsdiff.patch).not.toHaveBeenCalled();
  });

  it("rejects a member label that escapes the collection patches", async () => {
    await applyPatches(harness.api, collection, "skyrimse", "../../outside", "member", {
      "config.bin": "00000000",
    });
    expect(harness.errorNotifications[0]?.message).toBeInstanceOf(DataInvalid);
  });

  it("does not follow a staged source symlink outside its mod", async () => {
    const external = path.join(root, "outside.bin");
    await writeFile(external, "original");
    await symlink(external, path.join(staging, "member", "config.bin"));
    await writeFile(
      path.join(staging, "collection", "patches", "Member", "config.bin.diff"),
      "patch",
    );
    await applyPatches(harness.api, collection, "skyrimse", "Member", "member", {
      "config.bin": crc("original"),
    });
    expect(await readFile(external, "utf8")).toBe("original");
    expect(window.api.bsdiff.patch).not.toHaveBeenCalled();
    expect(harness.errorNotifications[0]?.message).toBeInstanceOf(DataInvalid);
  });

  it("retains the original file if replacement fails", async () => {
    const target = path.join(staging, "member", "config.bin");
    await writeFile(target, "original");
    await writeFile(
      path.join(staging, "collection", "patches", "Member", "config.bin.diff"),
      "patch",
    );
    const fault = new Error("replacement failure");
    vi.spyOn(fs, "renameAsync").mockImplementationOnce(() => Bluebird.reject(fault));
    await applyPatches(harness.api, collection, "skyrimse", "Member", "member", {
      "config.bin": crc("original"),
    });
    expect(await readFile(target, "utf8")).toBe("original");
    expect(harness.errorNotifications[0]?.message).toBe(fault);
    expect(await fs.readdirAsync(path.dirname(target))).toEqual(["config.bin"]);
  });

  it.each(["folder/config.bin", "folder\\config.bin"])(
    "applies a valid nested patch with %s separators",
    async (file) => {
      const target = path.join(staging, "member", "folder", "config.bin");
      const diff = path.join(
        staging,
        "collection",
        "patches",
        "Member",
        "folder",
        "config.bin.diff",
      );
      await mkdir(path.dirname(target));
      await mkdir(path.dirname(diff));
      await writeFile(target, "original");
      await writeFile(diff, "patch");
      await applyPatches(harness.api, collection, "skyrimse", "Member", "member", {
        [file]: crc("original"),
      });
      expect(await readFile(target, "utf8")).toBe("patched");
      expect(harness.errorNotifications).toEqual([]);
      expect(await fs.readdirAsync(path.dirname(target))).toEqual(["config.bin"]);
    },
  );

  it("keeps a file unchanged when its reference CRC differs", async () => {
    const target = path.join(staging, "member", "config.bin");
    await writeFile(target, "local edits");
    await writeFile(
      path.join(staging, "collection", "patches", "Member", "config.bin.diff"),
      "patch",
    );
    await applyPatches(harness.api, collection, "skyrimse", "Member", "member", {
      "config.bin": crc("original"),
    });
    expect(await readFile(target, "utf8")).toBe("local edits");
    expect(window.api.bsdiff.patch).not.toHaveBeenCalled();
    expect(harness.errorNotifications).toEqual([]);
  });

  it("rejects a patch symlink outside the collection", async () => {
    await writeFile(path.join(staging, "member", "config.bin"), "original");
    const external = path.join(root, "outside.diff");
    await writeFile(external, "patch");
    await symlink(
      external,
      path.join(staging, "collection", "patches", "Member", "config.bin.diff"),
    );
    await applyPatches(harness.api, collection, "skyrimse", "Member", "member", {
      "config.bin": crc("original"),
    });
    expect(window.api.bsdiff.patch).not.toHaveBeenCalled();
    expect(harness.errorNotifications[0]?.message).toBeInstanceOf(DataInvalid);
  });

  it("allows a source symlink within its mod and preserves the link", async () => {
    const target = path.join(staging, "member", "real.bin");
    const link = path.join(staging, "member", "config.bin");
    await writeFile(target, "original");
    await symlink(target, link);
    await writeFile(
      path.join(staging, "collection", "patches", "Member", "config.bin.diff"),
      "patch",
    );
    await applyPatches(harness.api, collection, "skyrimse", "Member", "member", {
      "config.bin": crc("original"),
    });
    expect(await fs.readlinkAsync(link)).toBe(target);
    expect(await readFile(target, "utf8")).toBe("patched");
    expect(harness.errorNotifications).toEqual([]);
  });
});
