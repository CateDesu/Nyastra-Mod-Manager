// TODO: remove polyfill with Node.js 26 upgrade
import { install } from "temporal-polyfill/shim";
install();

// IPC handler for forked child processes requesting Electron app info
if (process.send) {
  process.on("message", (msg: unknown) => {
    if (typeof msg === "object" && msg && "type" in msg && msg.type === "get-app-info") {
      // You can expand this object with more info as needed
      process.send?.({
        type: "app-info",
        appPath: app.getAppPath(),
        userData: app.getPath("userData"),
        temp: app.getPath("temp"),
        appData: app.getPath("appData"),
        exe: app.getPath("exe"),
        home: app.getPath("home"),
        documents: app.getPath("documents"),
        desktop: app.getPath("desktop"),
      });
    }
  });
}

import child_process from "node:child_process";
import { setDefaultResultOrder } from "node:dns";
import { appendFileSync, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import os from "os";

import {
  DEBUG_PORT,
  getErrorMessageOrDefault,
  HTTP_HEADER_SIZE,
  PROFILE_NAME,
  PROGRAM_NAME,
} from "@vortex/shared";
import { app, crashReporter, dialog } from "electron";
import i18next from "i18next";
import * as sourceMapSupport from "source-map-support";

app.setName(PROFILE_NAME);
app.setPath("userData", path.join(app.getPath("appData"), PROFILE_NAME));

// E2E test isolation: redirect userData and appData to temp directories so
// parallel test workers share no data and don't conflict with the real install.
if (process.env.VORTEX_E2E === "1") {
  if (process.env.ELECTRON_USERDATA) {
    app.setPath("userData", process.env.ELECTRON_USERDATA);
  }
  if (process.env.ELECTRON_APPDATA) {
    app.setPath("appData", process.env.ELECTRON_APPDATA);
  }
}

import { NativePathResolver } from "@vortex/shared/filesystem";

import Application from "./Application";
import { parseCommandline } from "./cli";
import { init as initDownloadIpc } from "./downloading/ipc";
import { DownloadManager } from "./downloading/manager";
import { terminateAsync } from "./errorHandling";
import {
  reportCrash,
  errorToReportableError,
  sendReportFile,
  disableErrorReporting,
} from "./errorReporting";
import { NodeFileSystemBackendImpl } from "./filesystem/backend";
import { NodeFileSystemImpl } from "./filesystem/filesystem-impl";
import { initFileSystem } from "./filesystem/instance";
import { PathResolverRegistryImpl } from "./filesystem/path-resolver-registry";
import { getVortexPath } from "./getVortexPath";
import { init as initIpcHandlers } from "./ipcHandlers";
import { log } from "./logging";
import StylesheetCompiler from "./stylesheetCompiler";
import { initTelemetryIpcHandler } from "./telemetry/ipcHandler";
import { init as initUploadIpc } from "./uploading/ipc";
import { UploadManager } from "./uploading/manager";

disableErrorReporting();

// Prefer reachable IPv4 endpoints unless the user selected a DNS order.
if (
  process.platform === "linux" &&
  !process.execArgv.some((arg) => arg.startsWith("--dns-result-order")) &&
  !process.env.NODE_OPTIONS?.includes("--dns-result-order")
) {
  setDefaultResultOrder("ipv4first");
}

process.env["UV_THREADPOOL_SIZE"] = (os.cpus().length * 2).toString();

const earlyErrHandler = (error: Error) => {
  // Show the dialog first — dialog.showErrorBox is synchronous in Electron
  // and blocks until the user dismisses it, giving the report time to send.
  if ("stack" in error && typeof error.stack === "string" && error.stack.includes("[as dlopen]")) {
    dialog.showErrorBox(
      "Nyastra's Mod Manager failed to start up",
      `An unexpected error occurred while Nyastra's Mod Manager was initialising:\n\n${error.message}\n\n` +
        "This is often caused by a bad installation of the app, " +
        "a security app interfering with Nyastra's Mod Manager " +
        "or a problem with the Microsoft Visual C++ Redistributable installed on your PC. " +
        "To solve this issue please try the following:\n\n" +
        "- Wait a moment and try starting Nyastra's Mod Manager again\n" +
        "- Reinstall Nyastra's Mod Manager from its downloaded archive\n" +
        "- Install the latest Microsoft Visual C++ Redistributable (find it using a search engine)\n" +
        "- Disable anti-virus or other security apps that might interfere and install Nyastra's Mod Manager again\n\n" +
        "If the issue persists, please create a thread in our support forum for further assistance.",
    );
  } else {
    dialog.showErrorBox(
      "Unhandled error",
      "Nyastra's Mod Manager failed to start up. This is usually caused by foreign software (e.g. Anti Virus) " +
        "interfering.\n\n" +
        error.stack,
    );
  }

  // Send the crash report after the dialog is dismissed, then exit.
  // reportCrash creates its own short-lived provider so it works before
  // the main telemetry provider is initialized.
  reportCrash("EarlyCrash", errorToReportableError(error))
    .catch(() => {
      /* best-effort — if this fails we still exit */
    })
    .finally(() => {
      app.exit(1);
    });
};

process.on("uncaughtException", earlyErrHandler);
process.on("unhandledRejection", earlyErrHandler);

// ensure the cwd is always set to the path containing the exe, otherwise dynamically loaded
// dlls will not be able to load vc-runtime files shipped with Vortex.
process.chdir(getVortexPath("application"));

sourceMapSupport.install();

function setEnv(key: string, value: string, force?: boolean) {
  if (process.env[key] === undefined || force) {
    process.env[key] = value;
  }
}

if (process.env.NODE_ENV !== "development") {
  setEnv("NODE_ENV", "production", true);
}

const handleError = (error: Error) => {
  if (Application.shouldIgnoreError(error)) {
    return;
  }

  // Use terminateAsync instead of terminate here because this handler is
  // registered on process 'uncaughtException' — throwing UserCanceled
  // from terminate() would be a double-fault that kills the process
  // before the dialog/report can run.
  void terminateAsync(error);
};

async function main(): Promise<void> {
  // important: The following has to be synchronous!
  const mainArgs = parseCommandline(process.argv, false);

  if (mainArgs.report) {
    return sendReportFile(mainArgs.report)
      .catch((err: unknown) => {
        log("warn", "failed to send crash report", {
          error: getErrorMessageOrDefault(err),
        });
      })
      .then(() => app.quit());
  }

  // Start Crashpad as early as possible so even startup crashes produce a
  // local crash dump for manual diagnostics.
  const dumpsPath = path.join(app.getPath("userData"), "temp", "dumps");
  try {
    mkdirSync(dumpsPath, { recursive: true });
  } catch {
    // ignored
  }
  app.setPath("crashDumps", dumpsPath);
  crashReporter.start({ uploadToServer: false });

  const NODE_OPTIONS = process.env.NODE_OPTIONS || "";
  process.env.NODE_OPTIONS =
    NODE_OPTIONS + ` --max-http-header-size=${HTTP_HEADER_SIZE}` + " --no-force-async-hooks-checks";

  if (mainArgs.disableGPU) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch("--disable-software-rasterizer");
    app.commandLine.appendSwitch("--disable-gpu");
  }

  app.commandLine.appendSwitch("disable-features", "WidgetLayering");
  app.commandLine.appendSwitch("disable-features", "UseEcoQoSForBackgroundProcess");

  // Switch from the startup dialog to the regular error handler.
  process.removeListener("uncaughtException", earlyErrHandler);
  process.removeListener("unhandledRejection", earlyErrHandler);
  process.on("uncaughtException", handleError);
  process.on("unhandledRejection", handleError);

  const downloadManager = new DownloadManager({ concurrency: 1 });
  const uploadManager = new UploadManager({ userAgent: `${PROGRAM_NAME}/${app.getVersion()}` });

  // The registry holds exactly one resolver for the universal `native`
  // scheme. Path providers are owned by the app, never by the registry.
  const fs = new NodeFileSystemImpl(
    new NodeFileSystemBackendImpl(),
    new PathResolverRegistryImpl([new NativePathResolver()]),
  );
  initFileSystem(fs);

  initIpcHandlers(fs);
  initDownloadIpc(downloadManager);
  initUploadIpc(uploadManager);
  initTelemetryIpcHandler();

  StylesheetCompiler.init();

  if (process.env.VORTEX_E2E === "1") {
    // Skip single-instance lock in e2e tests — each test worker runs its
    // own Electron instance with an isolated user data directory.
  } else if (!app.requestSingleInstanceLock()) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch("--in-process-gpu");
    app.commandLine.appendSwitch("--disable-software-rasterizer");
    app.quit();
    return;
  }

  // async code only allowed from here on out

  try {
    await stat(getVortexPath("userData"));
  } catch {
    // no-op
  }

  if (
    process.env.NODE_ENV === "development" &&
    !app.commandLine.hasSwitch("remote-debugging-port")
  ) {
    // In e2e mode, use port 0 (OS-assigned random port) to avoid conflicts
    // between parallel test workers. Otherwise use the fixed debug port.
    const port = process.env.VORTEX_E2E === "1" ? "0" : DEBUG_PORT;
    app.commandLine.appendSwitch("remote-debugging-port", port);
  }

  const fixedT = i18next.getFixedT("en");
  try {
    fixedT("dummy");
  } catch {
    /** ignored */
  }

  new Application(mainArgs);
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    handleError(err);
  } else {
    earlyErrHandler(new Error(getErrorMessageOrDefault(err)));
  }
});
