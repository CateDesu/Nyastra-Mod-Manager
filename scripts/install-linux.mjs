import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { importLinuxProfile } from "./import-linux-profile.mjs";

const desktopId = "io.github.CateDesu.NyastraModManager.desktop";
const mimeType = "x-scheme-handler/nxm";

function command(name, args, optional = false) {
  const result = spawnSync(name, args, { encoding: "utf8", timeout: 15000 });
  if (result.error || result.status !== 0) {
    const message = `${name}: ${result.error?.message || result.stderr.trim() || "command failed"}`;
    if (!optional) throw new Error(message);
    console.warn(message);
  }
  return result.stdout?.trim() || "";
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function desktopExec(value) {
  if (/[\x00-\x1f\x7f=%]/.test(value)) {
    throw new Error("The launcher path contains characters unsupported by desktop launchers");
  }
  return `"${value.replace(/[\\"`$]/g, "\\$&").replaceAll("\\", "\\\\")}"`;
}

function writeAtomic(filename, content, mode) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.vortex-native-${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode, flag: "wx" });
  renameSync(temporary, filename);
}

function mimeSnapshots(configHome, applications) {
  const desktops = (process.env.XDG_CURRENT_DESKTOP || "")
    .split(":")
    .filter((name) => /^[a-z0-9_-]+$/i.test(name))
    .map((name) => `${name.toLowerCase()}-`);
  return [...new Set(["", ...desktops])].flatMap((prefix) =>
    [configHome, applications].map((directory) => {
      const filename = path.join(directory, `${prefix}mimeapps.list`);
      try {
        return { filename, content: readFileSync(filename, "utf8") };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return { filename, content: "" };
      }
    }),
  );
}

function mimeEntries(content) {
  const entries = new Map();
  let section;
  for (const line of content.split("\n")) {
    if (line.startsWith("[")) section = line.trim();
    else if (line.startsWith(`${mimeType}=`)) entries.set(section, line);
  }
  return entries;
}

function restoreUnsetMime(snapshots) {
  for (const { filename, content } of snapshots) {
    if (!existsSync(filename)) continue;
    const before = mimeEntries(content);
    const current = readFileSync(filename, "utf8");
    let section;
    const restored = current
      .split("\n")
      .flatMap((line) => {
        if (line.startsWith("[")) section = line.trim();
        if (
          !["[Default Applications]", "[Added Associations]"].includes(section) ||
          !line.startsWith(`${mimeType}=`)
        )
          return [line];
        const apps = line
          .slice(mimeType.length + 1)
          .split(";")
          .filter(Boolean);
        if (!apps.includes(desktopId)) return [line];
        const previous = before.get(section);
        const remaining = apps.filter((app) => app !== desktopId);
        if (remaining.length === 0) return previous ? [previous] : [];
        const oldApps =
          previous
            ?.slice(mimeType.length + 1)
            .split(";")
            .filter(Boolean) || [];
        return [`${mimeType}=${[...new Set([...remaining, ...oldApps])].join(";")};`];
      })
      .join("\n");
    if (restored !== current) {
      writeAtomic(realpathSync(filename), restored, statSync(filename).mode & 0o777);
    }
  }
}

async function install() {
  if (process.platform !== "linux") throw new Error("This installer requires Linux");
  const args = process.argv.slice(2);
  let sourceDirectory;
  let importProfile;
  while (args.length) {
    const argument = args.shift();
    if (argument === "--import-profile" && args[0] && !importProfile) importProfile = args.shift();
    else if (!argument.startsWith("-") && !sourceDirectory) sourceDirectory = argument;
    else
      throw new Error(
        "Usage: node scripts/install-linux.mjs [app-directory] [--import-profile /path/to/profile]",
      );
  }

  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const appDirectory = path.resolve(sourceDirectory || path.join(repoRoot, "dist/linux-unpacked"));
  const sourceExecutable = ["nyastra-mod-manager", "vortex", "Vortex"]
    .map((name) => path.join(appDirectory, name))
    .find((filename) => existsSync(filename) && statSync(filename).isFile());
  if (!sourceExecutable) throw new Error(`No program executable found in ${appDirectory}`);
  accessSync(sourceExecutable, constants.X_OK);
  if (!existsSync(path.join(appDirectory, "resources/app.asar"))) {
    throw new Error(`Incomplete packaged program in ${appDirectory}`);
  }

  const home = homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local/share");
  const stateHome = process.env.XDG_STATE_HOME || path.join(home, ".local/state");
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  if (![dataHome, stateHome, configHome].every(path.isAbsolute)) {
    throw new Error("XDG data, state and configuration paths must be absolute");
  }
  const installRoot = path.join(dataHome, "nyastra-mod-manager");
  const installedApp = path.join(installRoot, "app");
  const executable = path.join(installedApp, path.basename(sourceExecutable));
  const wrapper = path.join(home, ".local/bin/nyastra-mod-manager");
  const applications = path.join(dataHome, "applications");
  const desktop = path.join(applications, desktopId);
  const exec = desktopExec(wrapper);
  mkdirSync(installRoot, { recursive: true });
  const lock = openSync(path.join(installRoot, ".install.lock"), "a", 0o600);
  try {
    // flock locks this shared file description until the installer closes it or exits.
    const locked = spawnSync("flock", ["--nonblock", "--conflict-exit-code", "73", "3"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", lock],
    });
    if (locked.error?.code === "ENOENT") {
      throw new Error("Linux installation requires flock. Install util-linux and add it to PATH.");
    }
    if (locked.status === 73) throw new Error("Another installer is already running");
    if (locked.error || locked.status !== 0) {
      throw new Error(
        `Unable to lock the installation: ${locked.error?.message || locked.stderr.trim()}`,
      );
    }
    const previousHandler = command("xdg-mime", ["query", "default", mimeType]);
    const previousMime = previousHandler ? undefined : mimeSnapshots(configHome, applications);
    if (existsSync(installedApp)) {
      if (lstatSync(installedApp).isSymbolicLink() || !statSync(installedApp).isDirectory()) {
        throw new Error(`Refusing to replace a non-directory installation: ${installedApp}`);
      }
      if (!existsSync(path.join(installedApp, "resources/app.asar"))) {
        throw new Error(`Refusing to replace an unrecognized directory: ${installedApp}`);
      }
    }
    const source = realpathSync(appDirectory);
    const destination = path.join(realpathSync(installRoot), "app");
    const selfInstall = source === destination;
    if (!selfInstall && destination.startsWith(`${source}${path.sep}`)) {
      throw new Error("The source program cannot contain the installation directory");
    }
    const backup = path.join(
      stateHome,
      "nyastra-mod-manager/install-backups",
      `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`,
    );
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(backup, "nxm-handler.txt"), `${previousHandler}\n`, { mode: 0o600 });
    const previousFiles = [];
    for (const filename of [wrapper, desktop]) {
      let saved;
      try {
        const info = lstatSync(filename);
        if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Not a file: ${filename}`);
        saved = path.join(backup, path.basename(filename));
        cpSync(filename, saved, {
          dereference: false,
          verbatimSymlinks: true,
        });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      previousFiles.push({ filename, saved });
    }

    const staging = path.join(installRoot, `.app-install-${process.pid}`);
    const previousApp = path.join(installRoot, `.app-previous-${process.pid}`);
    let movedPrevious = false;
    let movedNew = false;
    let registrationAttempted = false;
    let extensionResult;
    let imported;
    try {
      if (!selfInstall) {
        cpSync(source, staging, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          errorOnExist: true,
          force: false,
        });
        if (existsSync(installedApp)) {
          renameSync(installedApp, previousApp);
          movedPrevious = true;
        }
        renameSync(staging, installedApp);
        movedNew = true;
      }
      if (importProfile) {
        mkdirSync(configHome, { recursive: true });
        imported = importLinuxProfile(importProfile, configHome);
      }
      writeAtomic(
        wrapper,
        `#!/bin/sh
unset LD_PRELOAD LD_LIBRARY_PATH
case "\${1-}" in
  [nN][xX][mM]:*) set -- --install "$@" ;;
esac
exec ${shellQuote(executable)} "$@"
`,
        0o755,
      );
      writeAtomic(
        desktop,
        `[Desktop Entry]
Type=Application
Name=Nyastra's Mod Manager
Comment=Manage game mods
Exec=env ${exec} %u
Icon=${existsSync(path.join(installedApp, "nyastra.png")) ? path.join(installedApp, "nyastra.png") : "applications-games"}
Terminal=false
Categories=Game;
MimeType=${mimeType};
StartupNotify=true
`,
        0o644,
      );
      command("update-desktop-database", [applications], true);
      if (/(^|:)KDE(:|$)/i.test(process.env.XDG_CURRENT_DESKTOP || "")) {
        const cache = spawnSync("kbuildsycoca6", ["--noincremental"], {
          timeout: 15000,
          encoding: "utf8",
        });
        if (cache.error?.code === "ENOENT") command("kbuildsycoca5", ["--noincremental"], true);
        else if (cache.error || cache.status !== 0)
          console.warn("The KDE application cache could not be refreshed");
      }
      registrationAttempted = true;
      command("xdg-mime", ["default", desktopId, mimeType]);
      const extensionInstaller = path.join(installedApp, "linux-extensions/apply.mjs");
      if (existsSync(extensionInstaller)) {
        const { applyExtensions } = await import(pathToFileURL(extensionInstaller).href);
        extensionResult = await applyExtensions({
          userData: path.join(configHome, "NyastraModManager"),
        });
      }
    } catch (error) {
      imported?.rollback();
      for (const { filename, saved } of previousFiles) {
        rmSync(filename, { force: true });
        if (saved) cpSync(saved, filename, { dereference: false, verbatimSymlinks: true });
      }
      if (movedNew) rmSync(installedApp, { recursive: true, force: true });
      if (movedPrevious) renameSync(previousApp, installedApp);
      if (previousHandler) command("xdg-mime", ["default", previousHandler, mimeType], true);
      else if (registrationAttempted) restoreUnsetMime(previousMime);
      throw error;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    if (movedPrevious) rmSync(previousApp, { recursive: true, force: true });
    for (const entry of readdirSync(installRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\.app-(?:install|previous)-[1-9]\d*$/.test(entry.name))
        continue;
      try {
        rmSync(path.join(installRoot, entry.name), { recursive: true, force: true });
      } catch (error) {
        console.warn(`Old build cleanup failed: ${error.message}`);
      }
    }
    console.log(`Program files: ${installedApp}`);
    console.log(`Installed ${wrapper}`);
    console.log(`Desktop entry: ${desktop}`);
    if (imported)
      console.log(`Imported profile: ${imported.profile}. Sign in again before Nexus downloads.`);
    console.log(`Previous files and NXM association: ${backup}`);
    if (extensionResult)
      console.log(`Linux extension adaptations: ${JSON.stringify(extensionResult)}`);
  } finally {
    closeSync(lock);
  }
}

try {
  await install();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
