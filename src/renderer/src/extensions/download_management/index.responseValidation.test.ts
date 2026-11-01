import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import PromiseBB from "bluebird";
import Zip from "node-7z";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { IPCDownloadAdapter } from "../../IPCDownloadAdapter";
import { downloadsReducer } from "../../reducers/downloads";
import { makeApiHarness, makeDownload, makeProfile } from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import * as fs from "../../util/fs";
import init from "./index";
import { withArchiveMutation } from "./util/archiveOwnership";

vi.mock("./views/DownloadView", () => ({ default: () => null }));
vi.mock("./views/Settings", () => ({ default: () => null }));
vi.mock("./views/ShutdownButton", () => ({ default: () => null }));
vi.mock("./views/SpeedOMeter", () => ({ default: () => null }));
vi.mock("./downloadAttributes", () => ({ default: () => [] }));
vi.mock("./util/downloadDirectory", () => ({
  ensureDownloadsDirectory: () => PromiseBB.resolve(),
}));
vi.mock("./util/queryDLInfo", () => ({ default: () => PromiseBB.resolve() }));

const { mainHandlers, resolveResource } = vi.hoisted(() => ({
  mainHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  resolveResource: vi.fn(),
}));
vi.mock("../../../../main/src/ipc", () => ({
  betterIpcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mainHandlers.set(channel, handler),
    callback: resolveResource,
  },
}));
vi.mock("../../../../main/src/logging", () => ({ log: vi.fn() }));

interface NativeHandle {
  promise: Promise<void>;
  cancel(): unknown;
  waitForWrites(): Promise<void>;
}
interface NativeDownloads {
  get(id: string): NativeHandle | undefined;
  getState(id: string): { status: string } | undefined;
  numPending: number;
  numRunning: number;
}

// Load main through its own runtime boundary without adding it to the renderer type graph.
async function nativeDownloader() {
  const mainRoot = path.resolve(__dirname, "../../../../main/src/downloading");
  const managerPath = path.join(mainRoot, "manager.ts");
  const ipcPath = path.join(mainRoot, "ipc.ts");
  const managerModule = (await import(managerPath)) as {
    DownloadManager: new (options: { concurrency: number }) => NativeDownloads;
  };
  const ipcModule = (await import(ipcPath)) as { init(manager: NativeDownloads): void };
  const manager = new managerModule.DownloadManager({ concurrency: 1 });
  mainHandlers.clear();
  ipcModule.init(manager);
  return manager;
}

function invokeMain(channel: string, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(mainHandlers.get(channel)!({ sender: {} }, ...args));
}

const GAME = "game-a";
let root: string;
let harnesses: ReturnType<typeof makeApiHarness>[] = [];
let savedApi: typeof window.api;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nyastra-import-removal-"));
  await mkdir(path.join(root, GAME));
  savedApi = window.api;
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  window.api = {
    log: vi.fn(),
    downloader: { onResolve: vi.fn() },
  } as unknown as typeof window.api;
  vi.spyOn(fs, "watch").mockReturnValue({ close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher);
});

afterEach(async () => {
  for (const h of harnesses) await withArchiveMutation(h.api, async () => undefined);
  harnesses = [];
  vi.clearAllTimers();
  vi.useRealTimers();
  window.api = savedApi;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function setup(previous: boolean) {
  const old = makeDownload({
    id: "old",
    game: [GAME],
    state: "finished",
    localPath: "archive.zip",
    modInfo: { source: "local" },
  });
  const profile = makeProfile({ id: "profile", gameId: GAME });
  const h = makeApiHarness(
    {
      downloads: previous ? { old } : {},
      profiles: { [profile.id]: profile },
      activeProfileId: profile.id,
    },
    [{ path: ["persistent", "downloads"], reducer: downloadsReducer }],
  );
  h.setState((state) => {
    state.settings.downloads.path = root;
    state.session.base = { commandLine: {} } as typeof state.session.base;
  });
  h.api.registerProtocol = vi.fn();
  h.api.deregisterProtocol = vi.fn();
  h.api.lookupModMeta = vi.fn().mockResolvedValue([]);
  const once: Array<() => void> = [];
  const context = {
    api: h.api,
    once: (callback: () => void) => once.push(callback),
    registerReducer: vi.fn(),
    registerMainPage: vi.fn(),
    registerSettings: vi.fn(),
    registerFooter: vi.fn(),
    registerAction: vi.fn(),
    registerAttributeExtractor: vi.fn(),
    registerActionCheck: vi.fn(),
    registerTest: vi.fn(),
  } as unknown as IExtensionContext;
  expect(init(context)).toBe(true);
  once.forEach((callback) => callback());
  const adapter = new IPCDownloadAdapter(h.api);
  harnesses.push(h);
  h.setNextDialog({ action: "Replace", input: {} });
  return { ...h, old, adapter };
}

async function archives(kind: "file" | "directory", previous: boolean) {
  const destination = path.join(root, GAME, "archive.zip");
  const payload = path.join(root, "payload.txt");
  await writeFile(payload, "original payload");
  if (previous) await new Zip().add(destination, [payload]);
  const oldBytes = previous ? await readFile(destination) : undefined;
  const incoming = path.join(root, "incoming");
  await mkdir(incoming);
  const source = path.join(incoming, kind === "file" ? "archive.zip" : "archive");
  if (kind === "file") {
    await writeFile(payload, "replacement payload");
    await new Zip().add(source, [payload]);
  } else {
    await mkdir(source);
    await writeFile(path.join(source, "payload.txt"), "replacement payload");
  }
  return { destination, source, oldBytes };
}

function publicRemove(h: ReturnType<typeof setup>, id: string) {
  const callback = vi.fn();
  const promise = new Promise<Error | null>((resolve) =>
    h.api.events.emit("remove-download", id, (error) => {
      callback(error);
      resolve(error);
    }),
  );
  return { callback, promise };
}

for (const responseKind of [
  "zip",
  "compressed-zip",
  "head-html",
  "get-html",
  "redirect-html",
] as const) {
  it(`public fresh download validates the actual response: ${responseKind}`, async () => {
    const { source } = await archives("file", false);
    const body = await readFile(source);
    const html = Buffer.from("<html><body>Please sign in to download</body></html>");
    const gzip = await import("node:zlib");
    const compressed = gzip.gzipSync(body);
    const h = setup(false);
    h.setState((state) => {
      state.settings.automation = { ...state.settings.automation, install: true };
    });
    const manager = await nativeDownloader();
    const http = await import("node:http");
    const requests: Array<{ method: string; path: string; range?: string }> = [];
    const server = http.createServer((request, response) => {
      requests.push({ method: request.method!, path: request.url!, range: request.headers.range });
      if (request.method === "HEAD") {
        response.writeHead(200, {
          "content-type": responseKind === "head-html" ? "text/html" : "application/zip",
        });
        response.end();
      } else if (responseKind === "redirect-html" && request.url !== "/login") {
        response.writeHead(302, { location: "/login" });
        response.end();
      } else if (
        responseKind === "get-html" ||
        request.url === "/login" ||
        responseKind === "head-html"
      ) {
        response.writeHead(200, { "content-type": "text/html", "content-length": html.length });
        response.end(html);
      } else if (responseKind === "compressed-zip") {
        response.writeHead(200, {
          "content-type": "application/zip",
          "content-encoding": "gzip",
          "content-length": compressed.length,
        });
        response.end(compressed);
      } else {
        response.writeHead(200, {
          "content-type": "application/zip",
          "content-length": body.length,
        });
        response.end(body);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/archive.zip`;
    const work: Promise<unknown>[] = [];
    const track = <T>(operation: Promise<T>) => {
      work.push(operation);
      void operation.catch(() => undefined);
      return operation;
    };
    const resolver = vi.mocked(window.api.downloader.onResolve).mock.calls[0][0];
    resolveResource.mockImplementation((_channel, _sender, _timeout, collationId) =>
      resolver(collationId),
    );
    const entered = deferred<string>();
    const transfers: Promise<void>[] = [];
    Object.assign(window.api.downloader, {
      start: vi.fn((dest: string, collationId: number) =>
        track(
          (async () => {
            const result = (await invokeMain("download:start", dest, collationId)) as {
              downloadId: string;
            };
            const native = manager.get(result.downloadId)!;
            transfers.push(native.promise);
            void native.promise.catch(() => undefined);
            entered.resolve(result.downloadId);
            return result;
          })(),
        ),
      ),
      getStates: vi.fn((ids: string[]) => track(invokeMain("download:getStates", ids))),
      cancel: vi.fn((id: string) => track(invokeMain("download:cancel", id))),
    });
    const crypto = await import("node:crypto");
    const hashes = vi.fn((_algorithm: string, file: string) =>
      track(
        (async () => {
          const bytes = await readFile(file);
          return {
            hash: crypto.createHash("md5").update(bytes).digest("hex"),
            numBytes: bytes.length,
          };
        })(),
      ),
    );
    window.api.hash = { compute: hashes };
    const finished = vi.fn();
    const install = vi.fn();
    h.api.events.on("did-finish-download", finished);
    h.api.events.on("start-install-download", install);
    const callback = vi.fn();
    const original = track(
      new Promise<{ error: Error | null; id?: string }>((resolve) =>
        h.api.events.emit(
          "start-download",
          [url],
          { game: GAME },
          "archive.zip",
          (error, id) => {
            callback(error, id);
            resolve({ error, id });
          },
          "always",
        ),
      ),
    );
    const id = await entered.promise;
    const drain = async () => {
      let count = -1;
      while (count !== work.length + transfers.length) {
        count = work.length + transfers.length;
        await Promise.allSettled([...work, ...transfers]);
      }
      await withArchiveMutation(h.api, async () => undefined);
    };
    try {
      await Promise.allSettled(transfers);
      await vi.advanceTimersByTimeAsync(250);
      const result = await original;
      await drain();
      const row = h.getState().persistent.downloads.files[id];
      const output = await readFile(path.join(root, GAME, row.localPath)).catch(() => null);
      let extractedPayload: string | undefined;
      if (responseKind === "zip" || responseKind === "compressed-zip") {
        const extracted = path.join(root, "extract");
        await mkdir(extracted);
        await new Zip().extractFull(path.join(root, GAME, row.localPath), extracted);
        extractedPayload = await readFile(path.join(extracted, "payload.txt"), "utf8");
      }
      const removed = publicRemove(h, id);
      await removed.promise;
      await drain();
      expect(removed.callback).toHaveBeenCalledExactlyOnceWith(null);
      const invalid = ["head-html", "get-html", "redirect-html"].includes(responseKind);
      console.log(
        "RESPONSE_RESULT",
        JSON.stringify({
          responseKind,
          requests,
          nativeStatus: manager.getState(id)?.status,
          rowState: row.state,
          callbackError: result.error?.message ?? null,
          outputIsHtml: output?.equals(html) ?? false,
          hashes: hashes.mock.calls.length,
          finished: finished.mock.calls,
          installs: install.mock.calls,
          remaining: manager.numRunning,
          queued: manager.numPending,
        }),
      );
      expect(callback).toHaveBeenCalledTimes(1);
      expect(result.id).toBe(id);
      expect(manager.numRunning).toBe(0);
      expect(manager.numPending).toBe(0);
      if (invalid) {
        expect.soft(result.error).toBeInstanceOf(Error);
        expect
          .soft(manager.getState(id))
          .toMatchObject({ error: { data: { kind: "download:is-html" } } });
        expect.soft(output?.length ?? 0).toBe(0);
        expect.soft(row.state).toBe("failed");
        expect.soft(manager.getState(id)?.status).toBe("failed");
        expect.soft(finished.mock.calls).toEqual([[id, "failed"]]);
        expect.soft(install).toHaveBeenCalledTimes(0);
        expect.soft(hashes).toHaveBeenCalledTimes(0);
        if (responseKind !== "head-html")
          expect(requests.some((r) => r.method === "GET")).toBe(true);
      } else {
        expect(result.error).toBeNull();
        expect(row.state).toBe("finished");
        expect(manager.getState(id)?.status).toBe("completed");
        expect(finished.mock.calls).toEqual([[id, "finished"]]);
        expect(install).toHaveBeenCalledExactlyOnceWith(id);
        expect(hashes).toHaveBeenCalledTimes(1);
        expect(output).toEqual(body);
        expect(row.fileMD5).toBe(crypto.createHash("md5").update(body).digest("hex"));
        expect(extractedPayload).toBe("replacement payload");
      }
      expect(await readFile(source)).toEqual(body);
    } finally {
      manager.get(id)?.cancel();
      await drain();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      h.api.events.removeAllListeners();
    }
  });
}
