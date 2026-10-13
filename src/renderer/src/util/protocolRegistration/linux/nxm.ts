import * as path from "path";

import * as fs from "fs-extra";

import { log } from "../../log";
import {
  applicationsDirectory,
  getDefaultUrlSchemeHandler,
  refreshDesktopDatabase,
  setDefaultUrlSchemeHandler,
} from "./common";
import { escapeDesktopExecFilePath, escapeDesktopFilePath } from "./desktopFileEscaping";

const PACKAGE_DESKTOP_ID = "io.github.CateDesu.NyastraModManager.desktop";
const DEV_DESKTOP_ID = "io.github.CateDesu.NyastraModManager.dev.desktop";
const DEB_DESKTOP_ID = "nyastra-mod-manager.desktop";

export interface ILinuxNxmProtocolRegistrationOptions {
  setAsDefault: boolean;
  executablePath: string;
  appPath: string;
}

function shellArgument(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function writeText(filename: string, content: string, mode: number): boolean {
  let changed = true;
  try {
    changed = fs.readFileSync(filename, "utf8") !== content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (changed) fs.outputFileSync(filename, content, { encoding: "utf8" });
  fs.chmodSync(filename, mode);
  return changed;
}

function ensureLocalEntry(
  directory: string,
  desktopId: string,
  options: ILinuxNxmProtocolRegistrationOptions,
  image: string | undefined,
  development: boolean,
): boolean {
  const wrapper = path.join(directory, `${desktopId}.sh`);
  const executable = image ?? options.executablePath;
  const launch =
    shellArgument(executable) + (development ? " " + shellArgument(options.appPath) : "");
  const environment = development
    ? [
        "XDG_DATA_DIRS",
        "GIO_EXTRA_MODULES",
        "GDK_PIXBUF_MODULE_FILE",
        "CHROME_DEVEL_SANDBOX",
        "ELECTRON_OVERRIDE_DIST_PATH",
        "NODE_ENV",
      ]
        .filter((key) => process.env[key])
        .map((key) => `export ${key}=${shellArgument(process.env[key]!)}\n`)
        .join("")
    : "";
  const script = `#!/bin/sh\nunset LD_LIBRARY_PATH\nunset LD_PRELOAD\n${environment}if [ -n "$1" ]; then\n  exec ${launch} --install "$@"\nelse\n  exec ${launch}\nfi\n`;
  const wrapperChanged = writeText(wrapper, script, 0o755);
  let icon = "applications-games";
  const iconPath = path.join(directory, "io.github.CateDesu.NyastraModManager.png");
  try {
    fs.copyFileSync(path.join(options.appPath, "assets/images/nyastra.png"), iconPath);
    icon = escapeDesktopFilePath(iconPath);
  } catch (error) {
    log("debug", "local protocol icon unavailable", {
      error: error instanceof Error ? error.message : "Icon copy failed",
    });
  }
  const desktop = `[Desktop Entry]\nType=Application\nName=Nyastra's Mod Manager${development ? " (development)" : ""}\nNoDisplay=true\nExec=${escapeDesktopExecFilePath(wrapper)} %u\nTryExec=${escapeDesktopFilePath(wrapper)}\nIcon=${icon}\nTerminal=false\nCategories=Game;\nMimeType=x-scheme-handler/nxm;\nStartupWMClass=NyastraModManager\n`;
  return writeText(path.join(directory, desktopId), desktop, 0o644) || wrapperChanged;
}

export function registerLinuxNxmProtocolHandler(
  options: ILinuxNxmProtocolRegistrationOptions,
): boolean {
  const directory = applicationsDirectory();
  const candidate = process.env.APPIMAGE;
  const image = candidate && path.isAbsolute(candidate) ? candidate : undefined;
  const development =
    !image && (process.defaultApp === true || process.env.NODE_ENV === "development");
  const packagedEntry = [
    directory,
    "/usr/local/share/applications",
    "/usr/share/applications",
  ].find((base) => fs.existsSync(path.join(base, DEB_DESKTOP_ID)));
  const desktopId = development
    ? DEV_DESKTOP_ID
    : !image && packagedEntry
      ? DEB_DESKTOP_ID
      : PACKAGE_DESKTOP_ID;
  if (
    development ||
    image ||
    (!process.env.IS_FLATPAK && !fs.existsSync(path.join(directory, desktopId)) && !packagedEntry)
  ) {
    if (ensureLocalEntry(directory, desktopId, options, image, development))
      refreshDesktopDatabase(directory);
  }
  if (!options.setAsDefault) return false;
  const changed = getDefaultUrlSchemeHandler("nxm") !== desktopId;
  if (!setDefaultUrlSchemeHandler("nxm", desktopId))
    throw new Error("Desktop download link registration failed");
  return changed;
}

export function deregisterLinuxNxmProtocolHandler(): void {
  log("debug", "Linux protocol deregistration is handled by the desktop", { protocol: "nxm" });
}
