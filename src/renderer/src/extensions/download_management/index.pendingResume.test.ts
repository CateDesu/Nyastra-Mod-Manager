import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { UserCanceled } from "@vortex/shared/errors";
import type { WireDownloadCheckpoint } from "@vortex/shared/ipc";
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

const mainHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("../../../../main/src/ipc", () => ({
  betterIpcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mainHandlers.set(channel, handler),
    callback: vi.fn(),
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

function startImport(h: ReturnType<typeof setup>, source: string) {
  const callback = vi.fn();
  const promise = new Promise<string[]>((resolve) =>
    h.api.events.emit("import-downloads", [source], (ids: string[]) => {
      callback(ids);
      resolve(ids);
    }),
  );
  return { callback, promise };
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

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const schedule of [
  "pending-admission",
  "pending-response",
  "settled-response",
  "cancel-retry",
  "cancel-retry-user",
] as const) {
  for (const duplicate of [false, true]) {
    for (const delayedWrites of [false, true]) {
      if (schedule.startsWith("cancel-retry") && (duplicate || delayedWrites)) continue;
      it(`pending checkpoint removal retains later imports: ${schedule}, duplicate=${duplicate}, delayedWrites=${delayedWrites}`, async () => {
        const { source, destination } = await archives("file", false);
        const complete = await readFile(source);
        const prefix = complete.subarray(0, Math.floor(complete.length / 2));
        await writeFile(destination, prefix);
        const h = setup(true);
        const manager = await nativeDownloader();
        const requestEntered = deferred<void>();
        const admitted = deferred<void>();
        const releaseAdmission = deferred<void>();
        const releaseResponse = deferred<void>();
        const releaseBody = deferred<void>();
        const writesEntered = deferred<void>();
        const releaseWrites = deferred<void>();
        const http = await import("node:http");
        const requests: Array<{ method: string; range?: string }> = [];
        const serverWork: Promise<void>[] = [];
        const server = http.createServer((request, response) => {
          requests.push({ method: request.method!, range: request.headers.range });
          const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
          const start = range ? Number(range[1]) : 0;
          const end = range ? Number(range[2]) : complete.length - 1;
          response.writeHead(range ? 206 : 200, {
            "content-length": end - start + 1,
            "accept-ranges": "bytes",
            etag: '"local-fixture"',
            ...(range ? { "content-range": `bytes ${start}-${end}/${complete.length}` } : {}),
          });
          if (request.method === "HEAD") response.end();
          else {
            response.flushHeaders();
            admitted.resolve();
            serverWork.push(
              releaseBody.promise
                .then(() => response.end(complete.subarray(start, end + 1)))
                .then(() => undefined),
            );
          }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as { port: number };
        h.setState((state) => {
          Object.assign(state.persistent.downloads.files.old, {
            state: "paused",
            received: prefix.length,
            size: complete.length,
          });
          state.persistent.downloads.checkpoints = {
            old: {
              downloadId: "old",
              resource: `http://127.0.0.1:${address.port}/archive.zip`,
              dest: destination,
              completedRanges: [{ start: 0, end: prefix.length - 1 }],
              etag: '"local-fixture"',
            },
          };
        });
        const work: Promise<unknown>[] = [];
        const track = <T>(operation: Promise<T>) => {
          work.push(operation);
          void operation.catch(() => undefined);
          return operation;
        };
        const transfers: Promise<void>[] = [];
        let nativeCleaned = false;
        const resume = vi.fn((checkpoint: WireDownloadCheckpoint) =>
          track(
            (async () => {
              requestEntered.resolve();
              if (schedule === "pending-admission") await releaseAdmission.promise;
              await invokeMain("download:resume", checkpoint);
              const handle = manager.get("old")!;
              transfers.push(handle.promise);
              const wait = handle.waitForWrites.bind(handle);
              vi.spyOn(handle, "waitForWrites").mockImplementation(async () => {
                writesEntered.resolve();
                if (delayedWrites) await releaseWrites.promise;
                await wait();
              });
              if (schedule !== "settled-response") await releaseResponse.promise;
            })(),
          ),
        );
        const cancellationError =
          schedule === "cancel-retry-user"
            ? new UserCanceled()
            : new Error("cancel IPC unavailable");
        let cancellationAttempts = 0;
        const cancel = vi.fn((id: string) =>
          track(
            (async () => {
              cancellationAttempts++;
              if (schedule.startsWith("cancel-retry") && cancellationAttempts === 1)
                throw cancellationError;
              await invokeMain("download:cancel", id);
              nativeCleaned = true;
            })(),
          ),
        );
        Object.assign(window.api.downloader, { resume, cancel });
        const metadata = vi.fn((_ids: string[], callback: () => void) => callback());
        h.api.events.removeAllListeners("did-import-downloads");
        h.api.events.on("did-import-downloads", metadata);
        const resumeCallback = vi.fn();
        const run = () =>
          track(
            new Promise<Error | null>((resolve) =>
              h.api.events.emit("resume-download", "old", (error, id) => {
                resumeCallback(error, id);
                resolve(error);
              }),
            ),
          );
        const resumed = run();
        let second: Promise<Error | null> | undefined;
        let removal: ReturnType<typeof publicRemove> | undefined;
        let secondRemoval: ReturnType<typeof publicRemove> | undefined;
        let imported: ReturnType<typeof startImport> | undefined;
        let cleanedAtRemoval = false;
        let failedRemoval: ReturnType<typeof publicRemove> | undefined;
        let retainedAfterFailure = false;
        try {
          await requestEntered.promise;
          if (schedule !== "pending-admission") await admitted.promise;
          if (schedule === "settled-response") await resumed;
          if (duplicate) second = run();
          removal = publicRemove(h, "old");
          track(
            removal.promise.then(() => {
              cleanedAtRemoval = nativeCleaned;
            }),
          );
          if (duplicate) secondRemoval = publicRemove(h, "old");
          await withArchiveMutation(h.api, async () => undefined);
          await tick();
          const callbacksBeforeResponse = removal.callback.mock.calls.length;
          // Old removal can finish here. Retain that ordering to expose its later unlink.
          if (callbacksBeforeResponse > 0) {
            imported = startImport(h, source);
            await imported.promise;
          }
          releaseAdmission.resolve();
          await admitted.promise;
          releaseResponse.resolve();
          if (schedule.startsWith("cancel-retry")) {
            await resumed;
            failedRemoval = removal;
            await failedRemoval.promise;
            retainedAfterFailure = h.getState().persistent.downloads.files.old !== undefined;
            removal = publicRemove(h, "old");
            track(
              removal.promise.then(() => {
                cleanedAtRemoval = nativeCleaned;
              }),
            );
          }
          // An obsolete implementation can remove without contacting main on retry.
          const cancellationBoundary = await Promise.race([
            writesEntered.promise.then(() => "canceling"),
            removal.promise.then(() => "removed"),
          ]);
          if (cancellationBoundary === "removed" && !nativeCleaned) {
            releaseWrites.resolve();
            await invokeMain("download:cancel", "old");
          }
          await writesEntered.promise;
          await withArchiveMutation(h.api, async () => undefined);
          await tick();
          const callbacksBeforeWrites = removal.callback.mock.calls.length;
          releaseWrites.resolve();
          await resumed;
          if (second) await second;
          await removal.promise;
          if (secondRemoval) await secondRemoval.promise;
          if (!imported) imported = startImport(h, source);
          const ids = await imported.promise;
          await Promise.allSettled(work);
          await Promise.allSettled(transfers);
          await manager.get("old")!.waitForWrites();
          releaseBody.resolve();
          await Promise.all(serverWork);
          await withArchiveMutation(h.api, async () => undefined);
          expect(removal.callback).toHaveBeenCalledExactlyOnceWith(null);
          if (secondRemoval) expect(secondRemoval.callback).toHaveBeenCalledExactlyOnceWith(null);
          expect(imported.callback).toHaveBeenCalledExactlyOnceWith(ids);
          expect(ids).toHaveLength(1);
          expect(metadata).toHaveBeenCalledTimes(1);
          expect(resume).toHaveBeenCalledTimes(1);
          expect(cancel.mock.calls).toEqual(
            Array.from({ length: schedule.startsWith("cancel-retry") ? 2 : 1 }, () => ["old"]),
          );
          if (failedRemoval) {
            expect(failedRemoval.callback).toHaveBeenCalledExactlyOnceWith(cancellationError);
            expect(retainedAfterFailure).toBe(true);
          }
          expect(resumeCallback.mock.calls).toEqual(
            Array.from({ length: duplicate ? 2 : 1 }, () =>
              schedule === "settled-response"
                ? [null, "old"]
                : [
                    schedule.startsWith("cancel-retry")
                      ? cancellationError
                      : expect.any(UserCanceled),
                    undefined,
                  ],
            ),
          );
          expect(manager.numPending).toBe(0);
          expect(manager.numRunning).toBe(0);
          expect(transfers).toHaveLength(1);
          await expect(transfers[0]).resolves.toBeUndefined();
          expect(manager.getState("old")!.status).toBe("canceled");
          expect(requests).toEqual([
            { method: "HEAD", range: undefined },
            { method: "GET", range: `bytes=${prefix.length}-${complete.length - 1}` },
          ]);
          expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(ids);
          expect(h.getState().persistent.downloads.files[ids[0]].state).toBe("finished");
          expect(h.getState().persistent.downloads.checkpoints).toEqual({});
          expect(await readFile(source)).toEqual(complete);
          const actual = await readFile(destination).catch(
            (error: NodeJS.ErrnoException) => error.code,
          );
          expect(actual, "no obsolete cancellation may unlink a later import").toEqual(complete);
          if (schedule !== "settled-response") expect(callbacksBeforeResponse).toBe(0);
          if (delayedWrites) expect(callbacksBeforeWrites).toBe(0);
          expect(cleanedAtRemoval).toBe(true);
          expect(
            (await readdir(path.dirname(destination))).filter((name) =>
              name.startsWith("__vortex_tmp_"),
            ),
          ).toEqual([]);
          const extracted = path.join(root, "verified-import");
          await new Zip().extractFull(destination, extracted);
          expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
            "replacement payload",
          );
        } finally {
          releaseAdmission.resolve();
          releaseResponse.resolve();
          releaseWrites.resolve();
          releaseBody.resolve();
          manager.get("old")?.cancel();
          await Promise.allSettled(work);
          await Promise.allSettled(transfers);
          await manager.get("old")?.waitForWrites();
          await Promise.all(serverWork);
          if (removal) await removal.promise;
          if (secondRemoval) await secondRemoval.promise;
          if (imported) await imported.promise;
          await withArchiveMutation(h.api, async () => undefined);
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });
    }
  }
}

it("removes a checkpoint resume queued before its request reaches IPC", async () => {
  const { destination } = await archives("file", true);
  const h = setup(true);
  h.setState((state) => {
    state.persistent.downloads.files.old.state = "paused";
    state.persistent.downloads.checkpoints = {
      old: {
        downloadId: "old",
        resource: "https://example.invalid/archive.zip",
        dest: destination,
        completedRanges: [{ start: 0, end: 1 }],
        etag: undefined,
      },
    };
  });
  const entered = deferred<void>();
  const release = deferred<void>();
  const queue = withArchiveMutation(h.api, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const resume = vi.fn();
  const cancel = vi.fn();
  Object.assign(window.api.downloader, { resume, cancel });
  const callback = vi.fn();
  const pending = new Promise<Error | null>((resolve) =>
    h.api.events.emit("resume-download", "old", (error, id) => {
      callback(error, id);
      resolve(error);
    }),
  );
  const removal = publicRemove(h, "old");
  release.resolve();
  await queue;
  await pending;
  await removal.promise;
  await withArchiveMutation(h.api, async () => undefined);
  expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(Error), undefined);
  expect(resume).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  expect(removal.callback).toHaveBeenCalledExactlyOnceWith(null);
  expect(h.getState().persistent.downloads.files).toEqual({});
  expect(await readdir(path.dirname(destination))).toEqual([]);
});

for (const timing of ["response-turn", "after-resume"] as const) {
  for (const duplicate of [false, true]) {
    for (const heldWrites of [false, true]) {
      it(`public removal settles the native resume: ${timing}, duplicate=${duplicate}, heldWrites=${heldWrites}`, async () => {
        const { source, destination } = await archives("file", false);
        const bytes = await readFile(source);
        const prefix = bytes.subarray(0, Math.floor(bytes.length / 2));
        await writeFile(destination, prefix);
        const h = setup(true);
        const manager = await nativeDownloader();
        const admitted = deferred<void>();
        const responseReady = deferred<void>();
        const bodyReady = deferred<void>();
        const writesEntered = deferred<void>();
        const writesReady = deferred<void>();
        const cancellationAwaited = deferred<void>();
        const responseRemoval = deferred<ReturnType<typeof publicRemove>>();
        const requests: Array<{ method: string; range?: string }> = [];
        const serverWork: Promise<void>[] = [];
        const work: Promise<unknown>[] = [];
        const transfers: Promise<void>[] = [];
        const track = <T>(operation: Promise<T>) => {
          work.push(operation);
          void operation.catch(() => undefined);
          return operation;
        };
        const http = await import("node:http");
        const server = http.createServer((request, response) => {
          requests.push({ method: request.method!, range: request.headers.range });
          const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
          const start = range ? Number(range[1]) : 0;
          const end = range ? Number(range[2]) : bytes.length - 1;
          response.writeHead(range ? 206 : 200, {
            "content-length": end - start + 1,
            "accept-ranges": "bytes",
            etag: '"local-fixture"',
            ...(range ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}),
          });
          if (request.method === "HEAD") response.end();
          else {
            response.flushHeaders();
            admitted.resolve();
            serverWork.push(
              bodyReady.promise.then(() => {
                response.end(bytes.subarray(start, end + 1));
              }),
            );
          }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as { port: number };
        h.setState((state) => {
          Object.assign(state.persistent.downloads.files.old, {
            state: "paused",
            received: prefix.length,
            size: bytes.length,
          });
          state.persistent.downloads.checkpoints = {
            old: {
              downloadId: "old",
              resource: `http://127.0.0.1:${address.port}/archive.zip`,
              dest: destination,
              completedRanges: [{ start: 0, end: prefix.length - 1 }],
              etag: '"local-fixture"',
            },
          };
        });
        let removal: ReturnType<typeof publicRemove> | undefined;
        let secondRemoval: ReturnType<typeof publicRemove> | undefined;
        let imported: ReturnType<typeof startImport> | undefined;
        let cleaned = false;
        const resume = vi.fn((checkpoint: WireDownloadCheckpoint) => {
          const operation = track(
            (async () => {
              await invokeMain("download:resume", checkpoint);
              const handle = manager.get("old")!;
              transfers.push(handle.promise);
              const nativeWait = handle.waitForWrites.bind(handle);
              vi.spyOn(handle, "waitForWrites").mockImplementation(() =>
                track(
                  (async () => {
                    writesEntered.resolve();
                    if (heldWrites) await writesReady.promise;
                    await nativeWait();
                  })(),
                ),
              );
              await responseReady.promise;
            })(),
          );
          if (timing === "response-turn") {
            // Queue removal from the actual response promise.
            track(
              operation.then(() => {
                queueMicrotask(() => {
                  removal = publicRemove(h, "old");
                  if (duplicate) secondRemoval = publicRemove(h, "old");
                  responseRemoval.resolve(removal);
                });
              }),
            );
          }
          return operation;
        });
        const cancel = vi.fn((id: string) =>
          track(
            invokeMain("download:cancel", id).then(() => {
              cleaned = true;
            }),
          ),
        );
        Object.assign(window.api.downloader, {
          resume,
          cancel: (id: string) =>
            new Proxy(cancel(id), {
              get(target, property) {
                if (property === "then")
                  return (...args: Parameters<typeof target.then>) => {
                    cancellationAwaited.resolve();
                    return target.then(...args);
                  };
                const value = Reflect.get(target, property);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
        });
        const metadata = vi.fn((_ids: string[], callback: () => void) => callback());
        h.api.events.removeAllListeners("did-import-downloads");
        h.api.events.on("did-import-downloads", metadata);
        const resumeCallback = vi.fn();
        const run = () =>
          track(
            new Promise<Error | null>((resolve) =>
              h.api.events.emit("resume-download", "old", (error, id) => {
                resumeCallback(error, id);
                resolve(error);
              }),
            ),
          );
        const resumed = run();
        const second = duplicate ? run() : undefined;
        try {
          await admitted.promise;
          responseReady.resolve();
          if (timing === "response-turn") removal = await responseRemoval.promise;
          else {
            await resumed;
            if (second) await second;
            removal = publicRemove(h, "old");
            if (duplicate) secondRemoval = publicRemove(h, "old");
          }
          await Promise.race([writesEntered.promise, removal.promise]);
          // Release after the original cancel is awaited or removal has escaped.
          await Promise.race([cancellationAwaited.promise, removal.promise]);
          const callbacksBeforeWrites = removal.callback.mock.calls.length;
          writesReady.resolve();
          await removal.promise;
          if (secondRemoval) await secondRemoval.promise;
          await resumed;
          if (second) await second;
          const atRemoval = {
            cleaned,
            cancels: cancel.mock.calls.length,
            status: manager.getState("old")!.status,
            running: manager.numRunning,
          };
          imported = startImport(h, source);
          const ids = await imported.promise;
          bodyReady.resolve();
          await Promise.all(serverWork);
          await Promise.allSettled(transfers);
          await manager.get("old")!.waitForWrites();
          let count = -1;
          while (count !== work.length) {
            count = work.length;
            await Promise.allSettled(work);
          }
          await withArchiveMutation(h.api, async () => undefined);
          expect
            .soft(
              atRemoval.cancels,
              "successful removal must request native cancellation exactly once",
            )
            .toBe(1);
          expect
            .soft(atRemoval.cleaned, "successful removal must follow native cleanup")
            .toBe(true);
          expect.soft(atRemoval.status).toBe("canceled");
          expect.soft(atRemoval.running).toBe(0);
          if (heldWrites) expect.soft(callbacksBeforeWrites).toBe(0);
          expect(await resumed).toBeNull();
          expect(resumeCallback.mock.calls).toEqual(
            Array.from({ length: duplicate ? 2 : 1 }, () => [null, "old"]),
          );
          expect(removal.callback).toHaveBeenCalledExactlyOnceWith(null);
          if (secondRemoval) expect(secondRemoval.callback).toHaveBeenCalledExactlyOnceWith(null);
          expect.soft(cancel).toHaveBeenCalledExactlyOnceWith("old");
          expect.soft(manager.getState("old")!.status).toBe("canceled");
          expect(imported.callback).toHaveBeenCalledExactlyOnceWith(ids);
          expect(ids).toHaveLength(1);
          expect(metadata).toHaveBeenCalledTimes(1);
          expect(resume).toHaveBeenCalledTimes(1);
          expect(requests).toEqual([
            { method: "HEAD", range: undefined },
            { method: "GET", range: `bytes=${prefix.length}-${bytes.length - 1}` },
          ]);
          expect(manager.numPending).toBe(0);
          expect(manager.numRunning).toBe(0);
          expect(transfers).toHaveLength(1);
          await expect(transfers[0]).resolves.toBeUndefined();
          expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(ids);
          expect(h.getState().persistent.downloads.files[ids[0]].state).toBe("finished");
          expect(h.getState().persistent.downloads.checkpoints).toEqual({});
          expect(await readFile(source)).toEqual(bytes);
          const actual = await readFile(destination).catch(
            (error: NodeJS.ErrnoException) => error.code,
          );
          expect(actual, "the imported archive must survive native cleanup").toEqual(bytes);
          expect(
            (await readdir(path.dirname(destination))).filter((name) =>
              name.startsWith("__vortex_tmp_"),
            ),
          ).toEqual([]);
          const extracted = path.join(root, "extracted");
          await new Zip().extractFull(destination, extracted);
          expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
            "replacement payload",
          );
        } finally {
          responseReady.resolve();
          bodyReady.resolve();
          writesReady.resolve();
          manager.get("old")?.cancel();
          await resumed;
          if (second) await second;
          let count = -1;
          while (count !== work.length) {
            count = work.length;
            await Promise.allSettled(work);
          }
          await Promise.allSettled(transfers);
          await manager.get("old")?.waitForWrites();
          await Promise.all(serverWork);
          if (removal) await removal.promise;
          if (secondRemoval) await secondRemoval.promise;
          if (imported) await imported.promise;
          await withArchiveMutation(h.api, async () => undefined);
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });
    }
  }
}
