import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as https from "node:https";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { parseDuckDBVersion, buildExtensionUrl, downloadFile } from "./download-duckdb-extensions";

vi.mock("node:https", () => ({ get: vi.fn() }));

describe("parseDuckDBVersion", () => {
  it("strips the -r.X suffix and prepends v", () => {
    expect(parseDuckDBVersion("1.5.1-r.1")).toBe("v1.5.1");
  });

  it("works with higher revision numbers", () => {
    expect(parseDuckDBVersion("1.10.0-r.42")).toBe("v1.10.0");
  });

  it("throws on unexpected version format", () => {
    expect(() => parseDuckDBVersion("1.5.1")).toThrow(/unexpected/i);
    expect(() => parseDuckDBVersion("1.5.1-rc.1")).toThrow(/unexpected/i);
    expect(() => parseDuckDBVersion("not-a-version")).toThrow(/unexpected/i);
  });
});

describe("buildExtensionUrl", () => {
  it("rejects unknown repositories and path traversal in URL components", () => {
    const options = {
      type: "http" as const,
      name: "level_pivot",
      repository: "https://nexus-mods.github.io/duckdb-level-pivot/current_release",
      version: "v1.5.1",
      platform: "linux_amd64",
    };
    for (const field of ["name", "version", "platform", "repository"]) {
      expect(() => buildExtensionUrl({ ...options, [field]: "../../private" })).toThrow();
    }
    expect(() =>
      buildExtensionUrl({ ...options, repository: "https://127.0.0.1/private" }),
    ).toThrow(/untrusted/i);
  });

  it("builds a correct http extension URL", () => {
    const url = buildExtensionUrl({
      type: "http",
      name: "level_pivot",
      repository: "https://halgari.github.io/duckdb-level-pivot/current_release",
      version: "v1.5.1",
      platform: "windows_amd64",
    });
    expect(url).toBe(
      "https://halgari.github.io/duckdb-level-pivot/current_release/v1.5.1/windows_amd64/level_pivot.duckdb_extension.gz",
    );
  });

  it("builds a correct community extension URL", () => {
    const url = buildExtensionUrl({
      type: "community",
      name: "delta",
      version: "v1.5.1",
      platform: "linux_amd64",
    });
    expect(url).toBe(
      "https://community-extensions.duckdb.org/v1/v1.5.1/linux_amd64/delta.duckdb_extension.gz",
    );
  });

  it("throws when http extension is missing repository", () => {
    expect(() =>
      buildExtensionUrl({
        type: "http",
        name: "my_ext",
        version: "v1.5.1",
        platform: "windows_amd64",
      }),
    ).toThrow(/repository/i);
  });
});

describe("extension downloads", () => {
  let directory: string;
  let destination: string;
  const url =
    "https://nexus-mods.github.io/duckdb-level-pivot/current_release/v1.5.1/linux_amd64/level_pivot.duckdb_extension.gz";

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(path.join(tmpdir(), "nyastra-duckdb-"));
    destination = path.join(directory, "extension");
    await writeFile(destination, "previous extension");
  });

  afterEach(() => rm(directory, { recursive: true, force: true }));

  function respond(status: number, body = gzipSync("extension fixture")) {
    vi.mocked(https.get).mockImplementation((_url, callback: any) => {
      const request = Object.assign(new EventEmitter(), { setTimeout: vi.fn() });
      queueMicrotask(() => {
        const response = Object.assign(new PassThrough(), {
          statusCode: status,
          headers: { location: "https://127.0.0.1/private" },
        });
        callback(response);
        response.end(body);
      });
      return request as unknown as ReturnType<typeof https.get>;
    });
  }

  it("publishes a complete decompressed extension", async () => {
    respond(200);
    await downloadFile(url, destination);
    expect(await readFile(destination, "utf8")).toBe("extension fixture");
    expect(await readdir(directory)).toEqual(["extension"]);
  });

  it.each([301, 302, 307, 308, 404, 500])(
    "rejects HTTP %s without following redirects or replacing files",
    async (status) => {
      respond(status);
      await expect(downloadFile(url, destination)).rejects.toThrow(`HTTP ${status}`);
      expect(https.get).toHaveBeenCalledOnce();
      expect(await readFile(destination, "utf8")).toBe("previous extension");
      expect(await readdir(directory)).toEqual(["extension"]);
    },
  );

  it("removes partial files when decompression fails", async () => {
    respond(200, Buffer.from("invalid gzip"));
    await expect(downloadFile(url, destination)).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe("previous extension");
    expect(await readdir(directory)).toEqual(["extension"]);
  });

  it.each([
    "http://nexus-mods.github.io/private",
    "https://127.0.0.1/private",
    "https://nexus-mods.github.io.attacker.test/private",
    "https://nexus-mods.github.io@127.0.0.1/private",
    "https://user:password@nexus-mods.github.io/private",
    "https://nexus-mods.github.io:8443/private",
  ])("rejects untrusted URLs before making a request: %s", async (input) => {
    await expect(downloadFile(input, destination)).rejects.toThrow(/untrusted/i);
    expect(https.get).not.toHaveBeenCalled();
    expect(await readFile(destination, "utf8")).toBe("previous extension");
  });
});
