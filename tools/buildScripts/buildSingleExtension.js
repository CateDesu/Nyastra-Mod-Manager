"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const rootPath = fs.realpathSync(path.resolve(__dirname, "..", ".."));

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function main() {
  const [extensionName, buildScript = "build", ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !extensionName ||
    !/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/i.test(extensionName) ||
    !/^[a-z0-9_][a-z0-9:_-]*$/i.test(buildScript)
  ) {
    throw new Error("Usage: node buildSingleExtension.js <extension-name> [build-script]");
  }

  const extensionsRoot = path.join(rootPath, "extensions");
  const extensionPath = fs.realpathSync(path.join(extensionsRoot, extensionName));
  if (!inside(extensionsRoot, extensionPath) || !fs.statSync(extensionPath).isDirectory()) {
    throw new Error("Choose an extension inside the repository");
  }
  console.log(`Building ${extensionName}`);
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["run", buildScript], { cwd: extensionPath, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Extension build failed with exit code ${code}`));
    });
  });

  const source = fs.realpathSync(path.join(extensionPath, "dist"));
  if (!inside(extensionPath, source))
    throw new Error("Extension output must stay in its directory");
  const destination = path.join(rootPath, "out", "bundledPlugins", extensionName);
  for (let current = destination; current !== rootPath; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error("Refusing a linked output directory");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
  console.log(`Copied ${extensionName} to out/bundledPlugins`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
