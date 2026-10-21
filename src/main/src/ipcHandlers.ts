import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { VortexError } from "@vortex/shared";
import {
  QualifiedPath,
  type FileSystem,
  type StatResult,
  type Status,
  type StatusTime,
} from "@vortex/shared/filesystem";
import type {
  EnumerateEntryWire,
  HashAlgorithm,
  TemporalWire,
  VortexPaths,
} from "@vortex/shared/ipc";
import type { SerializableMenuItem } from "@vortex/shared/preload";
import type {
  IpcMainInvokeEvent,
  JumpListCategory,
  OpenDialogOptions,
  SaveDialogOptions,
  Settings,
  TraceConfig,
  TraceCategoriesAndOptions,
  WebContents,
} from "electron";
import {
  app,
  BrowserWindow,
  clipboard,
  contentTracing,
  dialog,
  ipcMain,
  Menu,
  powerSaveBlocker,
  WebContentsView,
} from "electron";

import { diffFiles as bsdiffDiff, patchFiles as bsdiffPatch } from "./bsdiff/host";
import { relaunch } from "./cli";
import { getVortexPath } from "./getVortexPath";
import { hashFile } from "./hash/host";
import { betterIpcMain } from "./ipc";
import { openUrl, openFile, showItemInFolder } from "./open";
import { createUpdateChecker } from "./updateCheck";
import { closeView, extraWebViews, registerView } from "./webview";

export interface GlobalWithRedux {
  getReduxState?: () => object;
  getReduxStateMsgpack?: (idx: number) => string;
}

export function init(fs: FileSystem) {
  const checkUpdates = createUpdateChecker(() => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    appPath: app.getAppPath(),
    arch: process.arch,
  }));
  betterIpcMain.handle("updater:check-linux", () => checkUpdates());
  // Resolve lazily because Application can override paths after IPC initialization.
  function resolveVortexPaths(): VortexPaths {
    const paths: VortexPaths = {
      base: getVortexPath("base"),
      base_unpacked: getVortexPath("base_unpacked"),
      assets: getVortexPath("assets"),
      assets_unpacked: getVortexPath("assets_unpacked"),
      modules: getVortexPath("modules"),
      modules_unpacked: getVortexPath("modules_unpacked"),
      bundledPlugins: getVortexPath("bundledPlugins"),
      locales: getVortexPath("locales"),
      package: getVortexPath("package"),
      package_unpacked: getVortexPath("package_unpacked"),
      application: getVortexPath("application"),
      userData: getVortexPath("userData"),
      appData: getVortexPath("appData"),
      localAppData: getVortexPath("localAppData"),
      temp: getVortexPath("temp"),
      home: getVortexPath("home"),
      documents: getVortexPath("documents"),
      exe: getVortexPath("exe"),
      desktop: getVortexPath("desktop"),
    };

    // Match readlink's normalization when comparing paths.
    for (const [key, value] of Object.entries(paths)) {
      paths[key as keyof VortexPaths] = path.normalize(value);
    }

    return paths;
  }

  betterIpcMain.handle("example:ping", () => "pong", { includeArgs: true });

  // Omit --user-data so protocol links reach the active instance and profile.
  function selfCL(_udPath: string | undefined): [string, string[]] {
    // -d makes the appended protocol URL a download argument.
    if (process.env.NODE_ENV === "development" && process.argv[1]) {
      // Protocol launches may use another working directory.
      const appPath = path.resolve(process.argv[1]);
      return [process.execPath, [appPath, "-d"]];
    } else {
      return [process.execPath, ["-d"]];
    }
  }

  betterIpcMain.handle(
    "dialog:showOpen",
    async (event: IpcMainInvokeEvent, options: OpenDialogOptions) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      return await dialog.showOpenDialog(window, options);
    },
  );

  betterIpcMain.handle(
    "dialog:showSave",
    async (event: IpcMainInvokeEvent, options: SaveDialogOptions) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      return await dialog.showSaveDialog(window, options);
    },
  );

  betterIpcMain.handle(
    "dialog:showMessageBox",
    async (event: IpcMainInvokeEvent, options: Electron.MessageBoxOptions) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      return await dialog.showMessageBox(window, options);
    },
  );

  betterIpcMain.handle(
    "dialog:showErrorBox",
    (_event: IpcMainInvokeEvent, title: string, content: string) => {
      console.error("[Error Box]", title, content);
      dialog.showErrorBox(title, content);
    },
  );

  betterIpcMain.handle(
    "app:setProtocolClient",
    (_event: IpcMainInvokeEvent, protocol: string, udPath: string | undefined) => {
      const [execPath, args] = selfCL(udPath);
      app.setAsDefaultProtocolClient(protocol, execPath, args);
    },
  );

  betterIpcMain.handle(
    "app:isProtocolClient",
    (_event: IpcMainInvokeEvent, protocol: string, udPath: string | undefined) => {
      const [execPath, args] = selfCL(udPath);
      return app.isDefaultProtocolClient(protocol, execPath, args);
    },
  );

  betterIpcMain.handle(
    "app:removeProtocolClient",
    (_event: IpcMainInvokeEvent, protocol: string, udPath: string | undefined) => {
      const [execPath, args] = selfCL(udPath);
      app.removeAsDefaultProtocolClient(protocol, execPath, args);
    },
  );

  betterIpcMain.handle("app:exit", (_event, exitCode) => {
    app.exit(exitCode);
  });

  // Flush synchronously because the renderer may exit immediately.
  ipcMain.on("diag:fatal", (event, message: string) => {
    try {
      const line =
        new Date().toISOString() +
        " [ERRO] [RENDERER] [diag] " +
        message.replace(/\r?\n/g, "\\n") +
        "\n";
      appendFileSync(path.join(app.getPath("userData"), "vortex.log"), line);
    } catch {
      // diagnostics must never throw
    }
    event.returnValue = null;
  });

  betterIpcMain.on("shell:openUrl", (_event, url) => {
    openUrl(new URL(url));
  });

  betterIpcMain.on("shell:openFile", (_event, filePath) => {
    openFile(filePath);
  });

  betterIpcMain.on("shell:showItemInFolder", (_event, filePath) => {
    showItemInFolder(filePath);
  });

  betterIpcMain.on("app:relaunch", (_event, args) => {
    relaunch(args);
  });

  betterIpcMain.handle("app:getName", () => {
    return app.getName();
  });

  betterIpcMain.handle("app:getPath", (_event: IpcMainInvokeEvent, name) => {
    return getVortexPath(name);
  });

  betterIpcMain.handle(
    "app:extractFileIcon",
    async (_event: IpcMainInvokeEvent, exePath: string, iconPath: string) => {
      const icon = await app.getFileIcon(exePath, { size: "normal" });
      await writeFile(iconPath, icon.toPNG());
    },
  );

  betterIpcMain.handle("app:getAppPath", (_event: IpcMainInvokeEvent) => {
    return app.getAppPath();
  });

  betterIpcMain.handle("app:getVersion", () => {
    return app.getVersion();
  });

  betterIpcMain.handle("app:getVortexPaths", () => {
    return resolveVortexPaths();
  });

  betterIpcMain.handle(
    "browserView:create",
    async (event: IpcMainInvokeEvent, src: string, partition: string, _isNexus: boolean) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const contentsId = event.sender.id;

      if (!window || window.isDestroyed()) throw new Error("Browser window is closed");

      const view = new WebContentsView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: partition,
          sandbox: true,
          webSecurity: false,
        },
      });
      view.setBackgroundColor("#00000000");

      const viewId = registerView(window, view);
      try {
        await view.webContents.loadURL(src);
        if (window.isDestroyed() || !view.webContents || view.webContents.isDestroyed()) {
          throw new Error("Browser window is closed");
        }
        window.contentView.addChildView(view);
        return viewId;
      } catch (err) {
        closeView(contentsId, viewId, window);
        throw err;
      }
    },
  );

  betterIpcMain.handle(
    "browserView:createWithEvents",
    async (
      event: IpcMainInvokeEvent,
      src: string,
      forwardEvents: string[],
      options: Electron.WebContentsViewConstructorOptions | undefined,
    ) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const contentsId = event.sender.id;

      if (!window || window.isDestroyed()) throw new Error("Browser window is closed");

      const typedOptions = options ?? {};
      const viewOptions: Electron.WebContentsViewConstructorOptions = {
        ...typedOptions,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: false,
          ...typedOptions?.webPreferences,
        },
      };

      const view = new WebContentsView(viewOptions);
      view.setBackgroundColor("#00000000");

      const updateBounds = () => {
        if (window && !window.isDestroyed()) {
          const bounds = window.getContentBounds();
          view.setBounds({
            x: 0,
            y: 0,
            width: bounds.width,
            height: bounds.height,
          });
        }
      };
      window?.on("resize", updateBounds);
      const viewId = registerView(window, view, () => window.off("resize", updateBounds));

      forwardEvents.forEach((eventId) => {
        view.webContents.on(
          eventId as Parameters<typeof view.webContents.on>[0],
          (evt, ...args) => {
            event.sender.send(`view-${viewId}-${eventId}`, JSON.stringify(args));
            evt?.preventDefault?.();
          },
        );
      });

      try {
        window.contentView.addChildView(view);
        await view.webContents.loadURL(src);
        if (window.isDestroyed() || !view.webContents || view.webContents.isDestroyed()) {
          throw new Error("Browser window is closed");
        }
        return viewId;
      } catch (err) {
        closeView(contentsId, viewId, window);
        throw err;
      }
    },
  );

  betterIpcMain.handle("browserView:close", (event: IpcMainInvokeEvent, viewId: string) => {
    const contentsId = event.sender.id;
    closeView(contentsId, viewId, BrowserWindow.fromWebContents(event.sender) ?? undefined);
  });

  betterIpcMain.handle(
    "browserView:position",
    (event: IpcMainInvokeEvent, viewId: string, rect: Electron.Rectangle) => {
      const contentsId = event.sender.id;
      extraWebViews[contentsId]?.[viewId]?.setBounds?.(rect);
    },
  );

  betterIpcMain.handle(
    "browserView:updateURL",
    (event: IpcMainInvokeEvent, viewId: string, newURL: string) => {
      const contentsId = event.sender.id;
      return extraWebViews[contentsId]?.[viewId]?.webContents.loadURL(newURL);
    },
  );

  betterIpcMain.handle(
    "app:setJumpList",
    (_event: IpcMainInvokeEvent, categories: JumpListCategory[]) => {
      try {
        app.setJumpList(categories);
      } catch (_err) {
        // Ignore jump list errors (not available on all platforms)
      }
    },
  );

  betterIpcMain.handle(
    "session:getCookies",
    async (event: IpcMainInvokeEvent, filter: Electron.CookiesGetFilter) => {
      return event.sender.session.cookies.get(filter);
    },
  );

  betterIpcMain.handle("window:getId", (event: IpcMainInvokeEvent) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window?.id ?? -1;
  });

  betterIpcMain.handle("window:minimize", (_event: IpcMainInvokeEvent, windowId: number) => {
    const window = BrowserWindow.fromId(windowId);
    window?.minimize();
  });

  betterIpcMain.handle("window:maximize", (_event: IpcMainInvokeEvent, windowId: number) => {
    const window = BrowserWindow.fromId(windowId);
    window?.maximize();
  });

  betterIpcMain.handle("window:unmaximize", (_event: IpcMainInvokeEvent, windowId: number) => {
    const window = BrowserWindow.fromId(windowId);
    window?.unmaximize();
  });

  betterIpcMain.handle("window:restore", (_event: IpcMainInvokeEvent, windowId: number) => {
    const window = BrowserWindow.fromId(windowId);
    window?.restore();
  });

  betterIpcMain.handle("window:close", (_event: IpcMainInvokeEvent, windowId: number) => {
    const window = BrowserWindow.fromId(windowId);
    window?.close();
  });

  betterIpcMain.handle("window:focus", (_event: IpcMainInvokeEvent, windowId: number) => {
    const window = BrowserWindow.fromId(windowId);
    window?.focus();
  });

  betterIpcMain.handle("window:show", (_event: IpcMainInvokeEvent, windowId: number) => {
    if (process.env.VORTEX_E2E_HEADLESS !== "1") {
      const window = BrowserWindow.fromId(windowId);
      window?.show();
    }
  });

  betterIpcMain.handle("window:hide", (_event: IpcMainInvokeEvent, windowId: number) => {
    const window = BrowserWindow.fromId(windowId);
    window?.hide();
  });

  betterIpcMain.handle("window:isMaximized", (_event: IpcMainInvokeEvent, windowId: number) => {
    const window = BrowserWindow.fromId(windowId);
    return window?.isMaximized() ?? false;
  });

  betterIpcMain.handle("window:isMinimized", (_event: IpcMainInvokeEvent, windowId: number) => {
    const window = BrowserWindow.fromId(windowId);
    return window?.isMinimized() ?? false;
  });

  betterIpcMain.handle("window:isFocused", (_event: IpcMainInvokeEvent, windowId: number) => {
    const window = BrowserWindow.fromId(windowId);
    return window?.isFocused() ?? false;
  });

  betterIpcMain.handle(
    "window:setAlwaysOnTop",
    (_event: IpcMainInvokeEvent, windowId: number, flag: boolean) => {
      const window = BrowserWindow.fromId(windowId);
      window?.setAlwaysOnTop(flag);
    },
  );

  betterIpcMain.handle("window:moveTop", (_event: IpcMainInvokeEvent, windowId: number) => {
    const window = BrowserWindow.fromId(windowId);
    window?.moveTop();
  });

  betterIpcMain.handle("window:getPosition", (_event: IpcMainInvokeEvent, windowId: number) => {
    const win = BrowserWindow.fromId(windowId);
    return (win?.getPosition() ?? [0, 0]) as [number, number];
  });

  betterIpcMain.handle(
    "window:setPosition",
    (_event: IpcMainInvokeEvent, windowId: number, x: number, y: number) => {
      const win = BrowserWindow.fromId(windowId);
      win?.setPosition(x, y);
    },
  );

  betterIpcMain.handle("window:getSize", (_event: IpcMainInvokeEvent, windowId: number) => {
    const win = BrowserWindow.fromId(windowId);
    return (win?.getSize() ?? [0, 0]) as [number, number];
  });

  betterIpcMain.handle(
    "window:setSize",
    (_event: IpcMainInvokeEvent, windowId: number, width: number, height: number) => {
      const win = BrowserWindow.fromId(windowId);
      win?.setSize(width, height);
    },
  );

  betterIpcMain.handle("window:isVisible", (_event: IpcMainInvokeEvent, windowId: number) => {
    const win = BrowserWindow.fromId(windowId);
    return win?.isVisible() ?? false;
  });

  betterIpcMain.handle("window:toggleDevTools", (_event: IpcMainInvokeEvent, windowId: number) => {
    const win = BrowserWindow.fromId(windowId);
    win?.webContents.toggleDevTools();
  });

  betterIpcMain.handle(
    "contentTracing:startRecording",
    async (_event: IpcMainInvokeEvent, options: TraceConfig | TraceCategoriesAndOptions) => {
      return await contentTracing.startRecording(options);
    },
  );

  betterIpcMain.handle(
    "contentTracing:stopRecording",
    async (_event: IpcMainInvokeEvent, resultPath: string) => {
      return await contentTracing.stopRecording(resultPath);
    },
  );

  betterIpcMain.handle("redux:getState", () => {
    const getReduxState = (global as GlobalWithRedux).getReduxState;
    if (typeof getReduxState === "function") {
      return Promise.resolve(getReduxState());
    }
    return Promise.resolve(undefined);
  });

  betterIpcMain.handle("redux:getStateMsgpack", (_event, idx) => {
    const getReduxStateMsgpack = (global as GlobalWithRedux).getReduxStateMsgpack;
    if (typeof getReduxStateMsgpack === "function") {
      return getReduxStateMsgpack(idx ?? 0);
    }
    return undefined;
  });

  betterIpcMain.handle(
    "app:setLoginItemSettings",
    (_event: IpcMainInvokeEvent, settings: Settings) => {
      app.setLoginItemSettings(settings);
    },
  );

  betterIpcMain.handle("app:getLoginItemSettings", () => {
    return app.getLoginItemSettings();
  });

  betterIpcMain.handle("clipboard:writeText", async (_event: IpcMainInvokeEvent, text: string) => {
    await clipboard.writeText(text);
  });

  betterIpcMain.handle("clipboard:readText", () => {
    return clipboard.readText();
  });

  betterIpcMain.handle("menu:setApplicationMenu", (event, template) => {
    const processTemplate = (
      items: SerializableMenuItem[],
    ): Electron.MenuItemConstructorOptions[] => {
      return items.map((item): Electron.MenuItemConstructorOptions => {
        const processed: Electron.MenuItemConstructorOptions = {
          ...item,
        } as Electron.MenuItemConstructorOptions;

        if (item.id) {
          processed.click = () => {
            event.sender.send("menu:click", item.id);
          };
        }

        if (item.submenu && Array.isArray(item.submenu)) {
          processed.submenu = processTemplate(item.submenu);
        }

        return processed;
      });
    };

    const menu = Menu.buildFromTemplate(processTemplate(template as SerializableMenuItem[]));
    Menu.setApplicationMenu(menu);
  });

  betterIpcMain.handle(
    "powerSaveBlocker:start",
    (_event: IpcMainInvokeEvent, type: "prevent-app-suspension" | "prevent-display-sleep") => {
      return powerSaveBlocker.start(type);
    },
  );

  betterIpcMain.handle("powerSaveBlocker:stop", (_event: IpcMainInvokeEvent, id: number) => {
    powerSaveBlocker.stop(id);
  });

  betterIpcMain.handle("powerSaveBlocker:isStarted", (_event: IpcMainInvokeEvent, id: number) => {
    return powerSaveBlocker.isStarted(id);
  });

  betterIpcMain.handle(
    "bsdiff:create",
    (_event: IpcMainInvokeEvent, oldPath: string, newPath: string, patchPath: string) =>
      bsdiffDiff(oldPath, newPath, patchPath),
  );

  betterIpcMain.handle(
    "bsdiff:apply",
    (_event: IpcMainInvokeEvent, oldPath: string, patchPath: string, outputPath: string) =>
      bsdiffPatch(oldPath, outputPath, patchPath),
  );

  betterIpcMain.handle(
    "hash:compute",
    (_event: IpcMainInvokeEvent, algorithm: HashAlgorithm, filePath: string) =>
      hashFile(algorithm, filePath),
  );

  betterIpcMain.handle("fs:copy", (_event, source, target, options) =>
    fs.copy(QualifiedPath.of(source), QualifiedPath.of(target), options),
  );

  betterIpcMain.handle("fs:createDirectory", (_event, dirPath) =>
    fs.createDirectory(QualifiedPath.of(dirPath)),
  );

  betterIpcMain.handle("fs:createLink", (_event, from, to, type) =>
    fs.createLink(QualifiedPath.of(from), QualifiedPath.of(to), type),
  );

  betterIpcMain.handle("fs:delete", (_event, inputPath) => fs.delete(QualifiedPath.of(inputPath)));

  betterIpcMain.handle("fs:deleteRecursive", (_event, inputPath) =>
    fs.deleteRecursive(QualifiedPath.of(inputPath)),
  );

  betterIpcMain.handle("fs:writeFile", (_event, inputPath, contents) =>
    fs.writeFile(QualifiedPath.of(inputPath), contents),
  );

  betterIpcMain.handle("fs:readFile", (_event, inputPath) =>
    fs.readFile(QualifiedPath.of(inputPath)),
  );

  betterIpcMain.handle("fs:move", (_event, source, target, options) =>
    fs.move(QualifiedPath.of(source), QualifiedPath.of(target), options),
  );

  betterIpcMain.handle("fs:stat", async (_event, inputPath, options) => {
    const result = await fs.stat(QualifiedPath.of(inputPath), options);
    return statToWire(result);
  });

  // Iterators stay in main because they cannot cross IPC.
  // Release handles on exhaustion, close or renderer destruction.
  const enumerations = new Map<
    number,
    {
      iterator: AsyncIterator<QualifiedPath | [QualifiedPath, Status]>;
      sender: WebContents;
      onDestroyed: () => void;
    }
  >();
  let nextEnumerationHandle = 1;

  const evictEnumeration = (handle: number) => {
    const session = enumerations.get(handle);
    if (session === undefined) return;

    enumerations.delete(handle);
    session.sender.removeListener("destroyed", session.onDestroyed);

    // Release the directory and detach the sender listener to prevent leaks.
    void session.iterator.return?.(undefined);
  };

  betterIpcMain.handle("fs:enumerate-open", async (event, inputPath, options) => {
    const iterator = await fs.enumerateDirectory(QualifiedPath.of(inputPath), options);
    const handle = nextEnumerationHandle++;
    const sender = event.sender;

    const onDestroyed = () => evictEnumeration(handle);
    sender.once("destroyed", onDestroyed);

    enumerations.set(handle, { iterator, sender, onDestroyed });
    return handle;
  });

  betterIpcMain.handle("fs:enumerate-next", async (_event, handle: number, max: number) => {
    const session = enumerations.get(handle);
    if (session === undefined) {
      throw new VortexError(`No enumeration session for handle ${handle}`, {
        kind: "argument-invalid",
        argument: "handle",
      });
    }

    const entries: EnumerateEntryWire[] = [];
    let done = false;
    try {
      for (let pulled = 0; pulled < max; pulled++) {
        const step = await session.iterator.next();
        if (step.done === true) {
          done = true;
          break;
        }

        entries.push(enumerationEntryToWire(step.value));
      }
    } catch (err) {
      evictEnumeration(handle);
      throw err;
    }

    if (done) {
      evictEnumeration(handle);
    }

    // A done reply still carries the tail of the listing.
    return { done, entries };
  });

  betterIpcMain.handle("fs:enumerate-close", (_event, handle: number) => {
    evictEnumeration(handle);
  });

  // Streams stay in main and exchange byte batches through numeric handles.
  // Release handles on exhaustion, close or renderer destruction.
  type StreamSession =
    | {
        kind: "read";
        reader: ReadableStreamDefaultReader<Uint8Array>;
        sender: WebContents;
        onDestroyed: () => void;
      }
    | {
        kind: "write";
        writer: WritableStreamDefaultWriter<Uint8Array>;
        sender: WebContents;
        onDestroyed: () => void;
      };

  const streams = new Map<number, StreamSession>();
  let nextStreamHandle = 1;

  const evictStream = (handle: number) => {
    const session = streams.get(handle);
    if (session === undefined) return;

    streams.delete(handle);
    session.sender.removeListener("destroyed", session.onDestroyed);
    if (session.kind === "read") {
      // Cancellation may reject if the stream already failed or closed.
      void session.reader.cancel().catch(() => undefined);
    } else {
      // Abandoned writes discard buffered bytes. Already flushed bytes remain on disk.
      void session.writer.abort().catch(() => undefined);
    }
  };

  betterIpcMain.handle("fs:stream-open", async (event, inputPath, mode, options) => {
    if (mode !== "r" && mode !== "w") {
      throw new VortexError(`Unknown stream mode '${String(mode)}' for '${inputPath.path}'`, {
        kind: "argument-invalid",
        argument: "mode",
      });
    }

    const sender = event.sender;
    const handle = nextStreamHandle++;
    const onDestroyed = () => evictStream(handle);

    if (mode === "r") {
      const stream = await fs.createStream(QualifiedPath.of(inputPath), "r", options);
      sender.once("destroyed", onDestroyed);
      streams.set(handle, { kind: "read", reader: stream.getReader(), sender, onDestroyed });
    } else {
      const stream = await fs.createStream(QualifiedPath.of(inputPath), "w", {
        start: options?.start,
      });
      sender.once("destroyed", onDestroyed);
      streams.set(handle, { kind: "write", writer: stream.getWriter(), sender, onDestroyed });
    }

    return handle;
  });

  betterIpcMain.handle("fs:stream-read", async (_event, handle: number, max: number) => {
    const session = streams.get(handle);
    if (session === undefined) {
      throw new VortexError(`No stream session for handle ${handle}`, {
        kind: "argument-invalid",
        argument: "handle",
      });
    }
    if (session.kind !== "read") {
      throw new VortexError(`Stream session ${handle} is a write stream`, {
        kind: "argument-invalid",
        argument: "handle",
      });
    }

    const chunks: Uint8Array[] = [];
    let collected = 0;
    let done = false;
    try {
      while (collected < max) {
        const step = await session.reader.read();
        if (step.done) {
          done = true;
          break;
        }
        collected += step.value.length;
        chunks.push(step.value);
      }
    } catch (error) {
      evictStream(handle);
      throw error;
    }

    if (done) {
      evictStream(handle);
    }

    // A done reply still carries the tail of the file.
    return { done, bytes: Buffer.concat(chunks) };
  });

  betterIpcMain.handle("fs:stream-write", async (_event, handle: number, bytes: Uint8Array) => {
    const session = streams.get(handle);
    if (session === undefined) {
      throw new VortexError(`No stream session for handle ${handle}`, {
        kind: "argument-invalid",
        argument: "handle",
      });
    }
    if (session.kind !== "write") {
      throw new VortexError(`Stream session ${handle} is a read stream`, {
        kind: "argument-invalid",
        argument: "handle",
      });
    }

    try {
      await session.writer.write(bytes);
    } catch (err) {
      // Abort the failed writer before reporting its error.
      evictStream(handle);
      throw err;
    }
  });

  betterIpcMain.handle("fs:stream-close", async (_event, handle: number) => {
    const session = streams.get(handle);
    // Exhaustion or an earlier error may have already evicted this handle.
    if (session === undefined) return;

    if (session.kind === "write") {
      // Flush before eviction aborts the writer.
      try {
        await session.writer.close();
      } finally {
        evictStream(handle);
      }
      return;
    }

    evictStream(handle);
  });

  betterIpcMain.handle("fs:stream-abort", async (_event, handle: number) => {
    const session = streams.get(handle);
    if (session === undefined) return;
    try {
      if (session.kind === "write") await session.writer.abort();
    } finally {
      evictStream(handle);
    }
  });
}

function enumerationEntryToWire(
  value: QualifiedPath | [QualifiedPath, Status],
): EnumerateEntryWire {
  if (Array.isArray(value)) {
    const [qualifiedPath, status] = value;
    return [qualifiedPath.toWire(), statusToWire(status)];
  }

  return value.toWire();
}

function statToWire(result: StatResult): TemporalWire<StatResult> {
  if (!result.exists) return result;
  return { exists: true, ...statusToWire(result) };
}

function statusToWire(status: Status): TemporalWire<Status> {
  if (status.isSymLink) {
    return {
      ...status,
      ...timesToWire(status),
      symLinkData: timesToWire(status.symLinkData),
    };
  }

  return {
    ...status,
    ...timesToWire(status),
  };
}

function timesToWire(times: StatusTime): TemporalWire<StatusTime> {
  return {
    accessTime: times.accessTime.epochNanoseconds,
    modifiedTime: times.modifiedTime.epochNanoseconds,
    changeTime: times.changeTime.epochNanoseconds,
    creationTime: times.creationTime.epochNanoseconds,
  };
}
