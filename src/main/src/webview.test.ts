import { EventEmitter } from "node:events";

import type { FileSystem } from "@vortex/shared/filesystem";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Handler = (event: unknown, ...args: unknown[]) => Promise<string>;

const { handlers, windows, views, MockView, initialLoad } = vi.hoisted(() => {
  const views: MockView[] = [];
  const initialLoad = vi.fn(() => Promise.resolve());
  class MockView {
    webContents = Object.assign(new EventEmitter(), {
      id: views.length + 100,
      loadURL: vi.fn(() => initialLoad()),
      isDestroyed: vi.fn(() => false),
      close: vi.fn(() => this.webContents.emit("destroyed")),
    });
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    constructor() {
      views.push(this);
    }
  }
  return {
    handlers: new Map<string, Handler>(),
    windows: new Map<number, ReturnType<typeof makeWindow>>(),
    views,
    MockView,
    initialLoad,
  };
});

vi.mock("electron", () => ({
  ipcMain: { on: vi.fn() },
  app: {},
  BrowserWindow: { fromWebContents: (sender: { id: number }) => windows.get(sender.id) },
  WebContentsView: MockView,
}));
vi.mock("./ipc", () => ({
  betterIpcMain: {
    handle: (name: string, handler: Handler) => handlers.set(name, handler),
    on: vi.fn(),
  },
}));
vi.mock("./cli", () => ({ relaunch: vi.fn() }));
vi.mock("./getVortexPath", () => ({ getVortexPath: vi.fn() }));
vi.mock("./open", () => ({ openUrl: vi.fn(), openFile: vi.fn(), showItemInFolder: vi.fn() }));
vi.mock("./bsdiff/host", () => ({ diffFiles: vi.fn(), patchFiles: vi.fn() }));
vi.mock("./hash/host", () => ({ hashFile: vi.fn() }));

import { init } from "./ipcHandlers";
import { closeAllViews, extraWebViews } from "./webview";

const sender = Object.assign(new EventEmitter(), { id: 1, send: vi.fn() });
let window: ReturnType<typeof makeWindow>;
const call = (name: string, ...args: unknown[]) =>
  handlers.get(`browserView:${name}`)!({ sender }, ...args);

function makeWindow() {
  return Object.assign(new EventEmitter(), {
    webContents: sender,
    isDestroyed: vi.fn(() => false),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  });
}

beforeEach(() => {
  views.length = 0;
  initialLoad.mockReset();
  initialLoad.mockResolvedValue(undefined);
  window = makeWindow();
  windows.set(sender.id, window);
  init({} as FileSystem);
});

afterEach(() => {
  closeAllViews(window as unknown as BrowserWindow);
  sender.removeAllListeners();
  windows.clear();
  vi.clearAllMocks();
});

it("does not reuse a live view ID after an earlier view closes", async () => {
  const first = await call("create", "about:blank", "test", false);
  const second = await call("create", "about:blank", "test", false);
  await call("close", first);
  const third = await call("create", "about:blank", "test", false);
  expect(third).not.toBe(second);
  expect(extraWebViews[sender.id]?.[second]).toBe(views[1]);
});

it("closes page contents and releases resize listeners", async () => {
  const id = await call("createWithEvents", "about:blank", [], undefined);
  await call("close", id);
  expect(views[0]!.webContents.close).toHaveBeenCalledOnce();
  expect(window.listenerCount("resize")).toBe(0);
  expect(extraWebViews[sender.id]?.[id]).toBeUndefined();
  await call("close", id);
  expect(views[0]!.webContents.close).toHaveBeenCalledOnce();
});

it("closes all page contents when the owner closes", async () => {
  await call("createWithEvents", "about:blank", [], undefined);
  await call("create", "about:blank", "test", false);
  closeAllViews(window as unknown as BrowserWindow);
  expect(views.every((view) => view.webContents.close.mock.calls.length === 1)).toBe(true);
  expect(window.listenerCount("resize")).toBe(0);
  expect(extraWebViews[sender.id]).toBeUndefined();
});

it("forwards loading notifications that carry no Electron event", async () => {
  const id = await call("createWithEvents", "about:blank", ["did-start-loading"], undefined);
  expect(() => views[0]!.webContents.emit("did-start-loading")).not.toThrow();
  expect(sender.send).toHaveBeenCalledWith(`view-${id}-did-start-loading`, "[]");
});

it("reports navigation failure to the caller", async () => {
  const id = await call("create", "about:blank", "test", false);
  views[0]!.webContents.loadURL.mockRejectedValueOnce(new Error("navigation failed"));
  await expect(call("updateURL", id, "https://invalid.example")).rejects.toThrow(
    "navigation failed",
  );
});

it.each(["create", "createWithEvents"])("cleans up failed %s navigation", async (method) => {
  initialLoad.mockRejectedValueOnce(new Error("navigation failed"));
  const pending = call(method, "about:blank", method === "create" ? "test" : [], false);
  await expect(pending).rejects.toThrow("navigation failed");
  expect(views[0]!.webContents.close).toHaveBeenCalledOnce();
  expect(sender.listenerCount("destroyed")).toBe(0);
  expect(window.listenerCount("resize")).toBe(0);
  expect(extraWebViews[sender.id]).toBeUndefined();
});

it("closes a view when its owner disappears during navigation", async () => {
  const navigation = Promise.withResolvers<void>();
  initialLoad.mockReturnValueOnce(navigation.promise);
  const pending = call("createWithEvents", "about:blank", [], undefined);
  window.isDestroyed.mockReturnValue(true);
  sender.emit("destroyed");
  navigation.resolve();
  await expect(pending).rejects.toThrow("Browser window is closed");
  expect(views[0]!.webContents.close).toHaveBeenCalledOnce();
  expect(window.listenerCount("resize")).toBe(0);
  expect(extraWebViews[sender.id]).toBeUndefined();
});
