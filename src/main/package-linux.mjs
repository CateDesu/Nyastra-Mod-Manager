import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pruneLocalBuilds } from "../../scripts/releases/cleanup-builds.mjs";
import { verifyAppImage } from "../../scripts/verify-appimage.mjs";
import { formatProgramVersion } from "../shared/src/programVersion.ts";

async function restorePackages(savedPackages, backupDirectory) {
  const failures = [];
  for (const [filename, backup] of savedPackages) {
    try {
      await lstat(backup);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      failures.push(error);
      continue;
    }
    try {
      await rename(backup, filename);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Restore previous packages from ${backupDirectory}`);
  }
}

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("The Linux preview currently packages x64 only");
}

const directory = fileURLToPath(new URL("./", import.meta.url));
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const utilityRequire = createRequire(builderRequire.resolve("builder-util/package.json"));
const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const version = formatProgramVersion(pkg.version);
const temporary = await mkdtemp(path.join(tmpdir(), "nyastra-builder-"));
let status;
let backupDirectory;
let verified = false;
const savedPackages = new Map();
const outputDirectory = path.resolve(directory, "../../dist");
const packages = ["zip", "AppImage", "deb"].map((extension) =>
  path.join(outputDirectory, `nyastra-${version}-linux-x64.${extension}`),
);
try {
  // FPM's compressor command cannot quote apostrophes in its binary path.
  const helper = path.join(temporary, "app-builder");
  const binary = path.join(temporary, "app-builder-bin");
  const template = path.resolve(directory, "../../scripts/AppRun.sh");
  await copyFile(utilityRequire("app-builder-bin").appBuilderPath, binary);
  await chmod(binary, 0o755);
  await writeFile(
    helper,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "appimage") args.push("--template", ${JSON.stringify(template)});
const result = spawnSync(${JSON.stringify(binary)}, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`,
    { mode: 0o755 },
  );
  await mkdir(outputDirectory, { recursive: true });
  backupDirectory = await mkdtemp(path.join(outputDirectory, ".nyastra-packages-"));
  for (const filename of packages) {
    try {
      const info = await lstat(filename);
      if (!info.isFile() && !info.isSymbolicLink()) {
        throw new Error(`Package output is not a file: ${filename}`);
      }
      const backup = path.join(backupDirectory, path.basename(filename));
      await rename(filename, backup);
      savedPackages.set(filename, backup);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("electron-builder/cli.js"),
      "--linux",
      "--x64",
      "--projectDir",
      path.join(directory, "dist"),
      "--config",
      path.join(directory, "dist/electron-builder.config.json"),
      `--config.linux.artifactName=nyastra-${version}-linux-x64.\${ext}`,
      `--config.buildNumber=${pkg.version.split("+")[1] ?? "0"}`,
      "--publish",
      "never",
      ...process.argv.slice(2),
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        PATH: temporary + path.delimiter + (process.env.PATH ?? ""),
        USE_SYSTEM_APP_BUILDER: "true",
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  status = result.status ?? 1;
  if (status === 0) {
    const appImage = packages[1];
    if (existsSync(appImage)) await verifyAppImage(appImage, template);
    // Check fresh outputs before restoring formats omitted by a targeted build.
    const outputs = await Promise.all(
      packages.map((filename) =>
        lstat(filename).catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        }),
      ),
    );
    const complete = outputs.every((info) => info?.isFile() && info.size > 0);
    for (const [filename, backup] of savedPackages) {
      if (outputs[packages.indexOf(filename)] === undefined) await rename(backup, filename);
    }
    verified = true;
    if (complete) {
      const removed = await pruneLocalBuilds(outputDirectory, pkg.version, "x64");
      console.log(`Removed ${removed} old local builds`);
    }
  }
} finally {
  try {
    if (!verified) await restorePackages(savedPackages, backupDirectory);
    if (backupDirectory) await rm(backupDirectory, { recursive: true, force: true });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
process.exitCode = status;
