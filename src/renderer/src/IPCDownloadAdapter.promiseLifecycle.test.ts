import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import Zip from "node-7z";
import { afterAll, expect, it, vi } from "vitest";

import { withArchiveMutation } from "./extensions/download_management/util/archiveOwnership";
import { IPCDownloadAdapter } from "./IPCDownloadAdapter";
import { downloadsReducer } from "./reducers/downloads";
import { makeApiHarness, makeDownload, makeProfile } from "./test-utils/builders";

const { mainHandlers, resolveResource } = vi.hoisted(() => ({
  mainHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  resolveResource: vi.fn(),
}));
vi.mock("../../main/src/ipc", () => ({
  betterIpcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mainHandlers.set(channel, handler),
    callback: resolveResource,
  },
}));
vi.mock("../../main/src/logging", () => ({ log: vi.fn() }));

interface NativeDownloads {
  get(id: string): { promise: Promise<void>; cancel(): void; waitForWrites(): Promise<void> };
  getState(id: string): { status: string };
  numPending: number;
  numRunning: number;
}

async function nativeDownloader() {
  const root = path.resolve(__dirname, "../../main/src/downloading");
  const managerPath = path.join(root, "manager.ts");
  const ipcPath = path.join(root, "ipc.ts");
  const managerModule = (await import(managerPath)) as {
    DownloadManager: new (options: { concurrency: number }) => NativeDownloads;
  };
  const ipcModule = (await import(ipcPath)) as { init(manager: NativeDownloads): void };
  const manager = new managerModule.DownloadManager({ concurrency: 1 });
  mainHandlers.clear();
  ipcModule.init(manager);
  return manager;
}

const NativePromise = globalThis.Promise;
const requireModule = createRequire(path.join(__dirname, "promise-lifecycle.cjs"));
afterAll(() => {
  globalThis.Promise = NativePromise;
});

for (const consumer of ["native", "mod-index", "downloads-settings"] as const) {
  it(`public checkpointless resume and native removal after ${consumer} loading`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "download-promise-lifecycle-"));
    const directory = path.join(root, "game-a");
    await mkdir(directory);
    const source = path.join(root, "source.zip");
    const payload = path.join(root, "payload.txt");
    await writeFile(payload, "complete archive payload");
    await new Zip().add(source, [payload]);
    const bytes = await readFile(source);
    const destination = path.join(directory, "archive.zip");
    await writeFile(destination, bytes.subarray(0, 16));
    const profile = makeProfile({ id: "profile", gameId: "game-a" });
    const h = makeApiHarness(
      {
        downloads: {
          old: makeDownload({
            id: "old",
            game: ["game-a"],
            state: "paused",
            localPath: "archive.zip",
            received: 16,
            size: bytes.length,
          }),
        },
        profiles: { profile },
        activeProfileId: profile.id,
      },
      [{ path: ["persistent", "downloads"], reducer: downloadsReducer }],
    );
    h.setState((state) => {
      state.settings.downloads.path = root;
      state.persistent.downloads.checkpoints = {};
    });
    const savedApi = window.api;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    window.api = {
      log: vi.fn(),
      downloader: { onResolve: vi.fn() },
    } as unknown as typeof window.api;
    new IPCDownloadAdapter(h.api);
    const manager = await nativeDownloader();
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.method!);
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": bytes.length,
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    });
    await new NativePromise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    h.setState((state) => {
      state.persistent.downloads.files.old.urls = [`http://127.0.0.1:${address.port}/archive.zip`];
    });
    const resolver = vi.mocked(window.api.downloader.onResolve).mock.calls[0][0];
    resolveResource.mockImplementation((_channel, _sender, _timeout, id) => resolver(id));
    const nativeWork: Promise<unknown>[] = [];
    const track = <T>(operation: Promise<T>) => {
      nativeWork.push(operation);
      void operation.catch(() => undefined);
      return operation;
    };
    const invokeMain = (channel: string, ...args: unknown[]) =>
      track(Promise.resolve(mainHandlers.get(channel)!({ sender: {} }, ...args)));
    const start = vi.fn((...args: unknown[]) => invokeMain("download:start", ...args));
    const cancel = vi.fn((id: string) => invokeMain("download:cancel", id));
    Object.assign(window.api.downloader, { start, cancel });
    const resumed = vi.fn();
    const removed = vi.fn();
    const finished = vi.fn();
    const installed = vi.fn();
    h.api.events.on("did-finish-download", finished);
    h.api.events.on("start-install-download", installed);
    const drain = async () => {
      let count = -1;
      while (count !== nativeWork.length) {
        count = nativeWork.length;
        await NativePromise.allSettled(nativeWork);
        await withArchiveMutation(h.api, async () => undefined);
      }
      await manager.get("old")?.waitForWrites();
    };
    try {
      if (consumer !== "native") {
        // Isolated route runs reload the actual dependency through their consumer.
        delete requireModule.cache[requireModule.resolve("turbowalk")];
        const consumerPath = path.resolve(
          __dirname,
          consumer === "mod-index"
            ? "./extensions/mod_management/index.ts"
            : "./extensions/download_management/views/Settings.tsx",
        );
        await import(consumerPath);
        expect(globalThis.Promise).toBe(requireModule("bluebird"));
        expect(globalThis.Promise.withResolvers).toBeUndefined();
      } else expect(globalThis.Promise).toBe(NativePromise);

      await new Promise<void>((resolve) =>
        h.api.events.emit("resume-download", "old", (error, id) => {
          resumed(error, id);
          resolve();
        }),
      );
      await NativePromise.allSettled([manager.get("old")?.promise]);
      await drain();
      const downloaded = await readFile(destination);
      const rowState = h.getState().persistent.downloads.files.old.state;
      await new Promise<void>((resolve) =>
        h.api.events.emit("remove-download", "old", (error) => {
          removed(error);
          resolve();
        }),
      );
      await drain();

      expect.soft(resumed).toHaveBeenCalledExactlyOnceWith(null, "old");
      expect.soft(start).toHaveBeenCalledTimes(1);
      expect.soft(cancel).toHaveBeenCalledExactlyOnceWith("old");
      expect.soft(downloaded).toEqual(bytes);
      expect.soft(rowState).toBe("init");
      expect.soft(requests).toEqual(["HEAD", "GET"]);
      expect(removed).toHaveBeenCalledExactlyOnceWith(null);
      expect(h.getState().persistent.downloads.files.old).toBeUndefined();
      expect(h.getState().persistent.downloads.checkpoints).toEqual({});
      expect(await readdir(directory)).toEqual([]);
      expect(await readFile(source)).toEqual(bytes);
      expect(finished).toHaveBeenCalledTimes(0);
      expect(installed).toHaveBeenCalledTimes(0);
      expect(manager.numRunning).toBe(0);
      expect(manager.numPending).toBe(0);
      if (consumer !== "native") {
        expect(globalThis.Promise).toBe(requireModule("bluebird"));
        expect(globalThis.Promise.withResolvers).toBeUndefined();
      }
    } finally {
      manager.get("old")?.cancel();
      await NativePromise.allSettled([manager.get("old")?.promise]);
      await drain();
      server.closeAllConnections();
      await new NativePromise<void>((resolve) => server.close(() => resolve()));
      h.api.events.removeAllListeners();
      vi.clearAllTimers();
      vi.useRealTimers();
      window.api = savedApi;
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });
}
