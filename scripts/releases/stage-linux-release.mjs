import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatProgramVersion } from "../../src/shared/src/programVersion.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, "src/main/package.json"), "utf8"));
const version = formatProgramVersion(pkg.version);
const prefix = `nyastra-${version}-linux-x64`;
const names = (await readdir(path.join(root, "dist"))).filter(
  (name) => name.startsWith(prefix + ".") && /\.(zip|deb|AppImage)$/.test(name),
);
if (names.length !== 3) throw new Error("Build the Linux ZIP, AppImage and Debian package first");
const release = path.join(root, "dist/release");
await rm(release, { recursive: true, force: true });
await mkdir(path.join(release, "assets"), { recursive: true });
for (const name of names)
  await copyFile(path.join(root, "dist", name), path.join(release, "assets", name));
if (version !== pkg.version)
  await copyFile(
    path.join(root, "dist", `${prefix}.zip`),
    path.join(release, "assets", `nyastra-${pkg.version}-linux-x64.zip`),
  );
await copyFile(path.join(root, "scripts/linux-README.txt"), path.join(release, "README.txt"));
await copyFile(path.join(root, "docs/packaging/linux-release.md"), path.join(release, "notes.md"));
await writeFile(
  path.join(release, "source.txt"),
  `Source for this build: https://github.com/CateDesu/Nyastra-Mod-Manager/tree/v${pkg.version}\nLicense: GPL-3.0\n`,
);
console.log(`Staged Linux release ${version} in ${release}`);
