import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { adapt, helperName } from "./adapt.mjs";

const recipeRoot = import.meta.dirname;

async function exists(filename) {
  try {
    await fs.lstat(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function rejectSymlinks(filename) {
  let candidate = path.resolve(filename);
  while (true) {
    try {
      if ((await fs.lstat(candidate)).isSymbolicLink())
        throw new Error(`Refusing extension symlink: ${candidate}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return;
    candidate = parent;
  }
}

async function replaceFile(filename, content, mode = 0o600) {
  const temporary = `${filename}.nyastra-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function defaultUserData() {
  const candidate = process.env.XDG_CONFIG_HOME;
  const root =
    candidate && path.isAbsolute(candidate) ? candidate : path.join(os.homedir(), ".config");
  return path.join(root, "NyastraModManager");
}

export async function applyExtensions({
  userData = defaultUserData(),
  sourcePlugins,
  dryRun = false,
} = {}) {
  const destinationRoot = path.resolve(userData, "plugins");
  const sourceRoot = sourcePlugins ? path.resolve(sourcePlugins) : destinationRoot;
  const manifest = JSON.parse(await fs.readFile(path.join(recipeRoot, "manifest.json"), "utf8"));
  const helper = await fs.readFile(path.join(recipeRoot, "runtime.cjs"));
  const plan = [];
  const skipped = [];
  for (const plugin of manifest.plugins) {
    const installHelper = plugin.helper !== false;
    const directory = path.join(destinationRoot, plugin.directory);
    if (!(await exists(directory))) {
      skipped.push({ plugin: plugin.name, reason: "Not installed" });
      continue;
    }
    const sourceDirectory = path.join(sourceRoot, plugin.directory);
    for (const filename of [
      directory,
      path.join(directory, "index.js"),
      path.join(directory, "info.json"),
      path.join(directory, helperName),
      path.join(sourceDirectory, "index.js"),
      path.join(sourceDirectory, "info.json"),
    ]) {
      await rejectSymlinks(filename);
    }
    const destinationInfo = JSON.parse(
      await fs.readFile(path.join(directory, "info.json"), "utf8"),
    );
    if (destinationInfo.name !== plugin.name || destinationInfo.version !== plugin.version) {
      skipped.push({
        plugin: plugin.name,
        reason: "Installed version differs from the supported recipe",
      });
      continue;
    }
    const sourceInfo = JSON.parse(
      await fs.readFile(path.join(sourceDirectory, "info.json"), "utf8"),
    );
    if (sourceInfo.name !== plugin.name || sourceInfo.version !== plugin.version) {
      throw new Error(`Source version does not match the installed extension: ${plugin.name}`);
    }
    const filename = path.join(directory, "index.js");
    const previous = await fs.readFile(filename);
    const source = await fs.readFile(path.join(sourceDirectory, "index.js"), "utf8");
    const updated = Buffer.from(adapt(source, plugin.game));
    const helperPath = installHelper ? path.join(directory, helperName) : undefined;
    const previousHelper =
      helperPath && (await exists(helperPath)) ? await fs.readFile(helperPath) : undefined;
    if (previous.equals(updated) && (!installHelper || previousHelper?.equals(helper))) {
      skipped.push({ plugin: plugin.name, reason: "Already adapted" });
      continue;
    }
    plan.push({
      plugin,
      filename,
      previous,
      updated,
      helperPath,
      previousHelper,
      mode: (await fs.stat(filename)).mode & 0o777,
    });
  }
  const result = {
    userData: path.resolve(userData),
    adapted: plan.map((entry) => entry.plugin.name),
    skipped,
    dryRun,
  };
  if (dryRun || plan.length === 0) return result;
  const backupRoot = path.join(
    path.resolve(userData),
    "extension-backups",
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
  );
  await rejectSymlinks(backupRoot);
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const changed = [];
  try {
    for (const entry of plan) {
      const backup = path.join(backupRoot, entry.plugin.directory);
      await fs.mkdir(backup, { mode: 0o700 });
      await fs.writeFile(path.join(backup, "index.js"), entry.previous, {
        flag: "wx",
        mode: 0o600,
      });
      if (entry.previousHelper) {
        await fs.writeFile(path.join(backup, helperName), entry.previousHelper, {
          flag: "wx",
          mode: 0o600,
        });
      }
    }
    for (const entry of plan) {
      changed.push(entry);
      if (entry.helperPath) await replaceFile(entry.helperPath, helper);
      await replaceFile(entry.filename, entry.updated, entry.mode);
    }
    result.backupRoot = backupRoot;
    await fs.writeFile(
      path.join(backupRoot, "receipt.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of changed.reverse()) {
      try {
        await replaceFile(entry.filename, entry.previous, entry.mode);
        if (entry.previousHelper) await replaceFile(entry.helperPath, entry.previousHelper);
        else if (entry.helperPath) await fs.rm(entry.helperPath, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `${error.message}. Restore extensions from ${backupRoot}. Rollback errors: ${rollbackErrors.join("; ")}`,
      );
    }
    throw error;
  }
  return result;
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--dry-run") options.dryRun = true;
    else if (option === "--user-data" || option === "--source-plugins") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing path after ${option}`);
      options[option === "--user-data" ? "userData" : "sourcePlugins"] = value;
    } else throw new Error(`Unknown option: ${option}`);
  }
  console.log(JSON.stringify(await applyExtensions(options), null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
