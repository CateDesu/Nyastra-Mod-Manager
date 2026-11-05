import type { FileSystem } from "@vortex/shared/filesystem";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => void>(),
  openExternal: vi.fn((_url: string) => Promise.resolve()),
}));
vi.mock("electron", () => ({
  app: {},
  BrowserWindow: {},
  clipboard: {},
  contentTracing: {},
  dialog: {},
  ipcMain: { on: vi.fn() },
  Menu: {},
  powerSaveBlocker: {},
  WebContentsView: {},
  shell: { openExternal: mocks.openExternal },
}));
vi.mock("./bsdiff/host", () => ({ diffFiles: vi.fn(), patchFiles: vi.fn() }));
vi.mock("./cli", () => ({ relaunch: vi.fn() }));
vi.mock("./getVortexPath", () => ({ getVortexPath: vi.fn() }));
vi.mock("./hash/host", () => ({ hashFile: vi.fn() }));
vi.mock("./ipc", () => ({
  betterIpcMain: {
    handle: vi.fn(),
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      mocks.listeners.set(channel, listener),
  },
}));
vi.mock("./updateCheck", () => ({ createUpdateChecker: () => vi.fn() }));
vi.mock("./webview", () => ({
  closeView: vi.fn(),
  extraWebViews: new Map(),
  registerView: vi.fn(),
}));
vi.mock("./logging", () => ({ log: vi.fn() }));

import { init } from "./ipcHandlers";

beforeEach(() => {
  mocks.listeners.clear();
  mocks.openExternal.mockClear();
  init({} as FileSystem);
});

test("opening a source website without a scheme leaves main running", () => {
  expect(() => mocks.listeners.get("shell:openUrl")!(undefined, "example.com")).not.toThrow();
  expect(mocks.openExternal).not.toHaveBeenCalled();
});

test("opening a valid source website reaches the desktop shell", () => {
  mocks.listeners.get("shell:openUrl")!(
    undefined,
    "https://www.nexusmods.com/skyrimspecialedition/mods/1",
  );
  expect(mocks.openExternal).toHaveBeenCalledWith(
    "https://www.nexusmods.com/skyrimspecialedition/mods/1",
  );
});
