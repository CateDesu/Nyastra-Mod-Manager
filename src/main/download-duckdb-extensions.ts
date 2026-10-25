import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import * as zlib from "node:zlib";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtensionConfig {
  platforms: string[];
  outputDir: string;
  extensions: ExtensionEntry[];
}

interface ExtensionEntry {
  name: string;
  type: "http" | "community";
  repository?: string;
}

interface BuildUrlOptions {
  type: "http" | "community";
  name: string;
  version: string;
  platform: string;
  repository?: string;
}

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parses a @duckdb/node-api version string (e.g. "1.5.1-r.1") into the
 * DuckDB core version string (e.g. "v1.5.1") used in extension download URLs.
 */
export function parseDuckDBVersion(rawVersion: string): string {
  const match = rawVersion.match(/^(\d+\.\d+\.\d+)-r\.\d+$/);
  if (match === null) {
    throw new Error(
      `Unexpected @duckdb/node-api version format: "${rawVersion}". ` +
        `Expected pattern: "<major>.<minor>.<patch>-r.<n>"`,
    );
  }
  return `v${match[1]}`;
}

/**
 * Constructs the download URL for a single extension/platform combination.
 */
export function buildExtensionUrl(opts: BuildUrlOptions): string {
  const { type, name, version, platform, repository } = opts;
  if (
    !/^[a-z0-9_]+$/.test(name) ||
    !/^[a-z0-9_]+$/.test(platform) ||
    !/^v\d+\.\d+\.\d+$/.test(version)
  ) {
    throw new Error("Invalid DuckDB extension name, platform or version");
  }

  if (type === "community") {
    return `https://community-extensions.duckdb.org/v1/${version}/${platform}/${name}.duckdb_extension.gz`;
  }

  if (type === "http") {
    if (!repository) {
      throw new Error(`Extension "${name}" has type "http" but is missing a "repository" field.`);
    }
    if (
      ![
        "https://nexus-mods.github.io/duckdb-level-pivot/current_release",
        "https://halgari.github.io/duckdb-level-pivot/current_release",
      ].includes(repository)
    ) {
      throw new Error(`Untrusted DuckDB extension repository: ${repository}`);
    }
    return `${repository}/${version}/${platform}/${name}.duckdb_extension.gz`;
  }

  throw new Error(`Unknown extension type: "${type as string}"`);
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

export async function downloadFile(url: string, destPath: string): Promise<void> {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    !["community-extensions.duckdb.org", "nexus-mods.github.io", "halgari.github.io"].includes(
      target.hostname,
    ) ||
    target.username ||
    target.password ||
    target.port
  ) {
    throw new Error("Untrusted DuckDB extension URL");
  }
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const temporary = `${destPath}.${randomUUID()}.tmp`;
  try {
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const request = https.get(target, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
          return;
        }
        resolve(res);
      });
      request.on("error", reject);
      request.setTimeout(30000, () =>
        request.destroy(new Error("DuckDB extension download timed out")),
      );
    });
    await pipeline(
      response,
      zlib.createGunzip(),
      fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    await fs.promises.rename(temporary, destPath);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const configPath = path.resolve(import.meta.dirname, "duckdb-extensions.json");
  const config: ExtensionConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));

  // Detect DuckDB version from the installed @duckdb/node-api package
  const nodeApiPkgPath = path.resolve(
    import.meta.dirname,
    "node_modules/@duckdb/node-api/package.json",
  );
  const nodeApiPkg = JSON.parse(fs.readFileSync(nodeApiPkgPath, "utf8"));
  const duckdbVersion = parseDuckDBVersion(nodeApiPkg.version as string);

  console.log(`DuckDB version: ${duckdbVersion}`);

  const outputDir = path.resolve(import.meta.dirname, config.outputDir);

  for (const ext of config.extensions) {
    for (const platform of config.platforms) {
      const url = buildExtensionUrl({
        type: ext.type,
        name: ext.name,
        version: duckdbVersion,
        platform,
        repository: ext.repository,
      });

      const destPath = path.join(
        outputDir,
        duckdbVersion,
        platform,
        `${ext.name}.duckdb_extension`,
      );

      if (fs.existsSync(destPath)) {
        console.log(`  skip  ${ext.name} [${platform}] — already exists`);
        continue;
      }

      console.log(`  download  ${ext.name} [${platform}]`);
      console.log(`    from: ${url}`);
      console.log(`    to:   ${destPath}`);
      await downloadFile(url, destPath);
      console.log(`  ✓ ${ext.name} [${platform}]`);
    }
  }

  console.log("Done.");
}

// Only run when executed directly (not when imported for testing)
const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
