import { EventEmitter } from "node:events";

import { ipcMain, type WebContents } from "electron";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { ipcMain: new EventEmitter() };
});
vi.mock("./logging", () => ({ log: vi.fn() }));

import { betterIpcMain } from "./ipc";

function renderer() {
  return Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    send: vi.fn(),
  });
}

afterEach(() => ipcMain.removeAllListeners());

test("a failed send rejects the callback and releases its listeners", async () => {
  const sender = renderer();
  const error = new Error("Render frame was disposed before WebFrameMain could be accessed");
  sender.send.mockImplementation(() => {
    throw error;
  });

  await expect(
    Promise.resolve().then(() =>
      betterIpcMain.callback("download:resolve", sender as unknown as WebContents, 0, 1),
    ),
  ).rejects.toBe(error);
  expect(ipcMain.listenerCount("callback:download:resolve")).toBe(0);
  expect(sender.eventNames()).toEqual([]);
});

test.each(["crash", "reload"])(
  "a renderer %s settles an untimed download resolution",
  async (event) => {
    const sender = renderer();
    const pending = betterIpcMain.callback(
      "download:resolve",
      sender as unknown as WebContents,
      0,
      1,
    );
    let failure: unknown;
    const settled = pending.catch((error: unknown) => {
      failure = error;
    });
    try {
      if (event === "crash") {
        sender.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
      } else {
        sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      }
      await new Promise((resolve) => setImmediate(resolve));
      expect(failure).toBeInstanceOf(Error);
      expect(ipcMain.listenerCount("callback:download:resolve")).toBe(0);
      expect(sender.eventNames()).toEqual([]);
    } finally {
      sender.emit("destroyed");
      await settled;
    }
  },
);

test("a reply must match its renderer and request and releases listeners on success", async () => {
  const sender = renderer();
  const pending = betterIpcMain.callback(
    "example:ping",
    sender as unknown as WebContents,
    0,
    12,
    "ping",
  );
  const result = { data: { pong: "pong" } };
  sender.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  ipcMain.emit("callback:example:ping", { sender: { id: 8 } }, 12, result);
  ipcMain.emit("callback:example:ping", { sender }, 13, result);
  expect(ipcMain.listenerCount("callback:example:ping")).toBe(1);
  ipcMain.emit("callback:example:ping", { sender }, 12, result);
  await expect(pending).resolves.toEqual(result.data);
  expect(ipcMain.listenerCount("callback:example:ping")).toBe(0);
  expect(sender.eventNames()).toEqual([]);
});
