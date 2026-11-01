import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect } from "vitest";

import { DOWNLOADS_DIR_TAG } from "../extensions/download_management/util/downloadDirectory";
import { STAGING_DIR_TAG } from "../extensions/mod_management/stagingDirectory";
import { test } from "../test-utils/harnessTest";
import { CleanupFailedException, UserCanceled } from "./CustomErrors";
import { transferPath } from "./transferPath";

for (const kind of [
  "new",
  "same-inode",
  "same-bytes",
  "conflict",
  "nested-tag",
  "folder-tags",
  "symlink",
  "abort-cleanup",
  "denied-cleanup",
  "nested-destination",
] as const) {
  test(`native directory transfer keeps original bytes: ${kind}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "staging-native-"));
    const source = path.join(root, "source");
    const dest =
      kind === "nested-destination"
        ? path.join(source, "nested-destination")
        : path.join(root, "destination");
    const rel = kind === "nested-tag" ? path.join("nested", STAGING_DIR_TAG) : "payload";
    const from = path.join(source, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(from), { recursive: true });
    fs.writeFileSync(from, "source bytes");
    fs.mkdirSync(dest, { recursive: true });
    const conflict = ["same-bytes", "conflict", "nested-tag", "symlink"].includes(kind);
    if (conflict || kind === "same-inode") {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (kind === "same-inode") fs.linkSync(from, to);
      else if (kind === "symlink") fs.symlinkSync(from, to);
      else fs.writeFileSync(to, kind === "same-bytes" ? "source bytes" : "prior bytes");
    }
    if (kind === "folder-tags")
      for (const tag of [STAGING_DIR_TAG, DOWNLOADS_DIR_TAG]) {
        fs.writeFileSync(path.join(source, tag), "source tag");
        fs.writeFileSync(path.join(dest, tag), "destination tag");
      }
    let cleanupCount = 0;
    const before = async () => {
      cleanupCount++;
      if (kind === "abort-cleanup") throw new UserCanceled();
      if (kind === "denied-cleanup") fs.chmodSync(source, 0);
    };
    const progress: Array<[string, string, number]> = [];
    const original = transferPath(source, dest, (...args) => progress.push(args), before);
    let error: unknown;
    try {
      await original.catch((cause) => {
        error = cause;
      });
      if (fs.existsSync(source)) fs.chmodSync(source, 0o700);
      if (conflict) {
        expect(error).toMatchObject({ code: "EEXIST" });
        expect(cleanupCount).toBe(0);
        expect(fs.readFileSync(from, "utf8")).toBe("source bytes");
        expect(fs.readFileSync(to, "utf8")).toBe(
          kind === "same-bytes" || kind === "symlink" ? "source bytes" : "prior bytes",
        );
        if (kind === "symlink") expect(fs.lstatSync(to).isSymbolicLink()).toBe(true);
      } else if (kind === "abort-cleanup" || kind === "denied-cleanup") {
        expect(error).toBeInstanceOf(
          kind === "abort-cleanup" ? UserCanceled : CleanupFailedException,
        );
        if (kind === "denied-cleanup")
          expect((error as CleanupFailedException).errorObject).toMatchObject({ code: "EACCES" });
        expect(cleanupCount).toBe(1);
        expect(fs.readFileSync(from, "utf8")).toBe("source bytes");
        expect(fs.readFileSync(to, "utf8")).toBe("source bytes");
      } else {
        expect(error).toBeUndefined();
        expect(cleanupCount).toBe(1);
        expect(fs.readFileSync(to, "utf8")).toBe("source bytes");
        if (kind !== "nested-destination") expect(fs.existsSync(source)).toBe(false);
        expect(progress.at(-1)?.[2]).toBe(100);
      }
      if (kind === "folder-tags")
        for (const tag of [STAGING_DIR_TAG, DOWNLOADS_DIR_TAG])
          expect(fs.readFileSync(path.join(dest, tag), "utf8")).toBe("destination tag");
    } finally {
      if (fs.existsSync(source)) fs.chmodSync(source, 0o700);
      await original.catch(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
