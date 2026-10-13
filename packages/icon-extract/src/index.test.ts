import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, it, expect } from "vitest";

import { extractIcon, extractIconToFile } from "./index";

const TEST_DATA_DIR = path.resolve(import.meta.dirname, "../test-data");
const REFERENCE_DIR = path.join(TEST_DATA_DIR, "reference");

const DOTNET_PROBE = path.resolve(
  import.meta.dirname,
  "../../../packages/pe-resources/test-data/probe.exe",
);

// PNG signature bytes
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG);
}

function pngDimensions(buf: Buffer): { width: number; height: number } | undefined {
  if (!isPng(buf) || buf.length < 24) return undefined;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

// --- Cross-platform tests ---

describe("extractIcon (cross-platform)", () => {
  it("returns undefined for non-existent file", async () => {
    expect(await extractIcon("/nonexistent/path/foo.exe")).toBeUndefined();
  });

  it("returns undefined for non-PE file", async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "iconext-")), "test.txt");
    fs.writeFileSync(tmp, "not a PE file");
    expect(await extractIcon(tmp)).toBeUndefined();
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  });

  it("returns undefined for empty file", async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "iconext-")), "empty.exe");
    fs.writeFileSync(tmp, Buffer.alloc(0));
    expect(await extractIcon(tmp)).toBeUndefined();
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  });

  it("handles PE without icons gracefully", async () => {
    expect(fs.existsSync(DOTNET_PROBE)).toBe(true);

    // dotnetprobe.exe is a console app — may not have icons
    const result = await extractIcon(DOTNET_PROBE);
    // Either returns a valid icon or undefined, but must not throw
    if (result !== undefined) {
      expect(isPng(result.png)).toBe(true);
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
    }
  });
});

describe("extractIconToFile (cross-platform)", () => {
  it("rejects for non-existent file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iconext-"));
    const outPath = path.join(tmpDir, "out.png");

    await expect(extractIconToFile("/nonexistent/path/foo.exe", outPath)).rejects.toThrow();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
