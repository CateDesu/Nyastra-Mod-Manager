import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { NativePathResolver, QualifiedPath } from "@vortex/shared/filesystem";
import type { PreloadWindow } from "@vortex/shared/preload";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeFileSystemBackendImpl } from "./filesystem/backend";
import { NodeFileSystemImpl } from "./filesystem/filesystem-impl";
import { PathResolverRegistryImpl } from "./filesystem/path-resolver-registry";
import { init } from "./ipcHandlers";
import type * as UpdateCheckModule from "./updateCheck";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: { on: vi.fn() },
  app: { isPackaged: true, getVersion: () => "2.9.0-beta.2+linux.2", getAppPath: () => "/unused" },
}));
vi.mock("./updateCheck", async (importOriginal) => {
  const original = await importOriginal<typeof UpdateCheckModule>();
  return {
    createUpdateChecker: (installation: Parameters<typeof original.createUpdateChecker>[0]) =>
      original.createUpdateChecker(installation, () => Promise.resolve([])),
  };
});
vi.mock("./ipc", () => ({
  betterIpcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    on: vi.fn(),
  },
}));
vi.mock("./cli", () => ({ relaunch: vi.fn() }));
vi.mock("./getVortexPath", () => ({ getVortexPath: vi.fn() }));
vi.mock("./open", () => ({ openUrl: vi.fn(), openFile: vi.fn(), showItemInFolder: vi.fn() }));
vi.mock("./bsdiff/host", () => ({ diffFiles: vi.fn(), patchFiles: vi.fn() }));
vi.mock("./hash/host", () => ({ hashFile: vi.fn() }));
vi.mock("../../preload/src/ipc", () => ({
  rendererInvoke: (name: string, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(name)!({ sender }, ...args)),
  rendererOn: vi.fn(),
  rendererOff: vi.fn(),
  rendererSend: vi.fn(),
  rendererCallback: vi.fn(),
}));

const sender = new EventEmitter();
let directory: string;
let fs: NodeFileSystemImpl;
let api: PreloadWindow["api"];

beforeAll(async () => {
  vi.stubGlobal("window", {});
  // Each TypeScript program checks its own sources. The test loads the actual preload.
  const preload = new URL("../../preload/src/index.ts", import.meta.url).href;
  await import(preload);
  api = (globalThis as unknown as { window: PreloadWindow }).window.api;
});

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "nyastra-stream-ipc-"));
  fs = new NodeFileSystemImpl(
    new NodeFileSystemBackendImpl(),
    new PathResolverRegistryImpl([new NativePathResolver()]),
  );
  handlers.clear();
  init(fs);
  vi.stubGlobal("window", { api });
});

afterEach(async () => {
  sender.emit("destroyed");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

it("checks package metadata through the actual preload and main update handler", async () => {
  expect(await api.updates.check()).toMatchObject({
    kind: "package",
    status: "unavailable",
    reason: "no-release",
    current: "2.9.0-beta.2+linux.2",
    url: "https://github.com/CateDesu/Nyastra-Mod-Manager/releases",
  });
});

it("releases an enumeration session when the real filesystem iterator fails", async () => {
  await symlink("loop", path.join(directory, "loop"));
  const iterator = await api.fs.enumerateDirectory(QualifiedPath.fromNative(directory), {
    includeStatus: true,
  });
  try {
    expect(sender.listenerCount("destroyed")).toBe(1);
    await expect(iterator.next()).rejects.toThrow();
    expect(sender.listenerCount("destroyed")).toBe(0);
  } finally {
    await iterator.return?.(undefined);
  }
});

describe("filesystem streams through preload and main handlers", () => {
  it("awaits closing a real Linux file before reporting success", async () => {
    const target = QualifiedPath.fromNative(path.join(directory, "output"));
    const stream = await api.fs.createStream(target, "w");
    const writer = stream.getWriter();
    await writer.write(Buffer.from("saved bytes"));
    await writer.close();
    expect(await readFile(target.path, "utf8")).toBe("saved bytes");
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

  it("propagates a flush failure across both component boundaries", async () => {
    const failure = new Error("flush failed");
    vi.spyOn(fs, "createStream").mockResolvedValue(
      new WritableStream({
        close() {
          throw failure;
        },
      }),
    );
    const stream = await api.fs.createStream(
      QualifiedPath.fromNative(path.join(directory, "output")),
      "w",
    );
    await expect(stream.getWriter().close()).rejects.toBe(failure);
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

  it("keeps close pending until the underlying stream has finished", async () => {
    let release: () => void = () => undefined;
    const flushed = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(fs, "createStream").mockResolvedValue(new WritableStream({ close: () => flushed }));
    const stream = await api.fs.createStream(
      QualifiedPath.fromNative(path.join(directory, "output")),
      "w",
    );
    let closed = false;
    const closing = stream
      .getWriter()
      .close()
      .then(() => (closed = true));
    await new Promise((resolve) => setImmediate(resolve));
    try {
      expect(closed).toBe(false);
    } finally {
      release();
      await closing;
    }
  });

  it("aborts instead of gracefully flushing an abandoned write", async () => {
    const abort = vi.fn();
    const close = vi.fn();
    vi.spyOn(fs, "createStream").mockResolvedValue(new WritableStream({ abort, close }));
    const stream = await api.fs.createStream(
      QualifiedPath.fromNative(path.join(directory, "output")),
      "w",
    );
    await stream.getWriter().abort();
    expect(abort).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

  it("releases a read handle when the underlying reader fails", async () => {
    const failure = new Error("read failed");
    vi.spyOn(fs, "createStream").mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.error(failure);
        },
      }),
    );
    const stream = await api.fs.createStream(
      QualifiedPath.fromNative(path.join(directory, "input")),
      "r",
    );
    await expect(stream.getReader().read()).rejects.toBe(failure);
    expect(sender.listenerCount("destroyed")).toBe(0);
  });
});
