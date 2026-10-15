import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pruneLocalBuilds } from "../../scripts/releases/cleanup-builds.mjs";

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("The Linux preview currently packages x64 only");
}

const directory = fileURLToPath(new URL("./", import.meta.url));
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const utilityRequire = createRequire(builderRequire.resolve("builder-util/package.json"));
const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const temporary = await mkdtemp(path.join(tmpdir(), "nyastra-builder-"));
let status;
try {
  // FPM's compressor command cannot quote apostrophes in its binary path.
  const helper = path.join(temporary, "app-builder");
  await copyFile(utilityRequire("app-builder-bin").appBuilderPath, helper);
  await chmod(helper, 0o755);
  for (const extension of ["zip", "AppImage", "deb"]) {
    await rm(path.join(directory, "../../dist", `nyastra-${pkg.version}-linux-x64.${extension}`), {
      force: true,
    });
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
      `--config.linux.artifactName=nyastra-${pkg.version}-linux-x64.\${ext}`,
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
    const removed = await pruneLocalBuilds(path.join(directory, "../../dist"), pkg.version, "x64");
    console.log(`Removed ${removed} old local builds`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
process.exitCode = status;
