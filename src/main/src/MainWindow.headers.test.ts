import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import MainWindow from "./MainWindow";

type Headers = { requestHeaders: Record<string, string> };
type HeaderListener = (
  details: Headers & { url: string },
  callback: (reply: Headers) => void,
) => void;
const { intercept } = vi.hoisted(() => ({
  intercept: vi.fn<(filter: { urls: string[] }, listener: HeaderListener) => void>(),
}));
vi.mock("electron", () => ({
  app: {},
  ipcMain: { on: vi.fn() },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1600, height: 900 } }) },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      session: { webRequest: { onBeforeSendHeaders: intercept }, on: vi.fn() },
      setWindowOpenHandler: vi.fn(),
    });
    loadURL = () => Promise.resolve();
  },
}));
vi.mock("./logging", () => ({ log: vi.fn() }));
vi.mock("./errorHandling", () => ({
  isQuitting: vi.fn(),
  terminate: vi.fn(),
  terminateAsync: vi.fn(),
}));
vi.mock("./errorReporting", () => ({ reportCrash: vi.fn() }));
vi.mock("./getVortexPath", () => ({ getVortexPath: () => "/tmp/nyastra-window-test" }));
vi.mock("./open", () => ({ openUrl: vi.fn() }));
vi.mock("./telemetry/state", () => ({ isTelemetryEnabled: () => false }));

describe("main window request headers", () => {
  it("keeps the ENB and video overrides in Electron's single active listener", () => {
    intercept.mockClear();
    const main = new MainWindow(false);
    void main.create();
    expect(intercept).toHaveBeenCalledOnce();
    const [filter, listener] = intercept.mock.calls[0]!;
    expect(filter.urls).toContain("*://enbdev.com/*");
    expect(filter.urls).toContain("*://www.youtube-nocookie.com/*");
    const enb = {
      url: "https://enbdev.com/download.html",
      requestHeaders: { "User-Agent": "original" },
    };
    const video = {
      url: "https://www.youtube-nocookie.com/embed/test",
      requestHeaders: { "User-Agent": "original" },
    };
    const callback = vi.fn<(reply: Headers) => void>();
    listener(enb, callback);
    expect(enb.requestHeaders["User-Agent"]).toContain("Mozilla/5.0");
    expect(callback).toHaveBeenCalledOnce();
    callback.mockClear();
    listener(video, callback);
    expect(video.requestHeaders["User-Agent"]).toBe("original");
    expect(callback.mock.calls[0]![0].requestHeaders.Referer).toBe("https://vortex.nexusmods.com");
  });
});
